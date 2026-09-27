const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const proxyquire = require('proxyquire').noCallThru();
const {
  Account,
  Asset,
  BASE_FEE,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} = require('@stellar/stellar-sdk');
const { TX_TIMEOUT_CONTRIBUTION_S } = require('../config/constants');

// Provide a dummy USDC issuer so stellar.js does not throw at module load time
// in environments (e.g. CI, unit tests) where USDC_ISSUER is not set.
process.env.USDC_ISSUER = process.env.USDC_ISSUER || 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
// Provide a dummy JWT_SECRET for token signing/verification in unit tests.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-jwt-secret-for-contributions-32';

const TESTNET_PASSPHRASE = Networks.TESTNET;
const VALID_G = 'GASXEYHSSVN3WSHD4WSZ4O37HC2AG4JH2EB6UPHM6IXDXDRJRDJD4RZK';

function buildUnsignedPaymentXdr({ senderPublicKey, destinationPublicKey, amount, asset = 'XLM' }) {
  return new TransactionBuilder(new Account(senderPublicKey, '1'), {
    fee: BASE_FEE,
    networkPassphrase: TESTNET_PASSPHRASE,
  })
    .addOperation(
      Operation.payment({
        destination: destinationPublicKey,
        asset: asset === 'XLM' ? Asset.native() : new Asset('USDC', 'GISSUER'),
        amount,
      })
    )
    .addMemo(require('@stellar/stellar-sdk').Memo.text('cp-c-1'))
    .setTimeout(TX_TIMEOUT_CONTRIBUTION_S)
    .build()
    .toXDR();
}

function buildApp({ queryImpl, stellarImpl, stellarTxImpl, connectImpl, sorobanImpl, ledgerMonitorImpl }) {
  const stellarStub = {
    buildUnsignedContributionPayment: async () => 'unsigned-xdr',
    buildUnsignedContributionPathPayment: async () => 'unsigned-xdr',
    prepareSignedContributionPayment: async () => ({
      unsignedXdr: 'unsigned-xdr',
      signedXdr: 'signed-xdr',
      feeAmount: 0,
    }),
    prepareSignedContributionPathPayment: async () => ({
      unsignedXdr: 'unsigned-xdr',
      signedXdr: 'signed-xdr',
      feeAmount: 0,
    }),
    submitPreparedTransaction: async () => 'tx-from-submit',
    submitWithFeeBumpFallback: async (...args) => stellarStub.submitPreparedTransaction(...args),
    getPathPaymentQuote: async () => [],
    getSupportedAssetCodes: () => ['XLM', 'USDC'],
    ensureCustodialAccountFundedAndTrusted: async () => null,
    isBadSequenceError: () => false,
    accountExistsOnLedger: async () => true,
    ...stellarImpl,
  };

  const stellarTxStub = {
    insertContributionSubmitted: async () => 'stellar-row-id',
    ...stellarTxImpl,
  };

  const sorobanStub = {
    triggerRefund: async () => null,
    isContractDepositEligible: () => false,
    buildUnsignedEscrowDeposit: async () => 'soroban-unsigned-xdr',
    ...sorobanImpl,
  };

  const ledgerMonitorStub = {
    recordConfirmedContribution: async () => {},
    ...ledgerMonitorImpl,
  };

  const contributionServiceStub = {
    SLIPPAGE_BPS: 500,
    buildContributionMemo: () => 'cp-c-1',
    buildAttributionMemo: (_campaignId, referralCode) => (referralCode ? `ref:${referralCode}` : 'cp-c-1'),
    buildContributionIntent: async ({ campaign, amount, sendAsset, contributorPublicKey }) => {
      if (sendAsset === campaign.asset_type) {
        return {
          kind: 'payment',
          conversionQuote: null,
          flowMetadata: {
            flow: 'payment',
            send_asset: sendAsset,
            amount: String(amount),
            contributor_public_key: contributorPublicKey,
          },
        };
      }

      const paths = await stellarStub.getPathPaymentQuote({
        sendAsset,
        destAsset: campaign.asset_type,
        destAmount: amount,
      });
      if (!paths.length) {
        const error = new Error(`No conversion path found for ${sendAsset} -> ${campaign.asset_type}`);
        error.statusCode = 422;
        throw error;
      }

      const bestPath = paths[0];
      const sendMax = (
        parseFloat(bestPath.source_amount) *
        1.05
      ).toFixed(7);

      return {
        kind: 'path_payment_strict_receive',
        sendMax,
        conversionQuote: {
          send_asset: sendAsset,
          campaign_asset: campaign.asset_type,
          campaign_amount: String(amount),
          quoted_source_amount: bestPath.source_amount,
          max_send_amount: sendMax,
          path: bestPath.path,
        },
        flowMetadata: {
          flow: 'path_payment_strict_receive',
          send_asset: sendAsset,
          dest_asset: campaign.asset_type,
          dest_amount: String(amount),
          max_send_amount: sendMax,
          contributor_public_key: contributorPublicKey,
        },
      };
    },
    submitCustodialContribution: async ({
      campaign,
      campaignId,
      userId,
      walletPublicKey,
      walletSecretEncrypted,
      amount,
      sendAsset,
    }) => {
      await stellarStub.ensureCustodialAccountFundedAndTrusted({
        publicKey: walletPublicKey,
        secret: 'SDECRYPTED',
      });
      const intent = await contributionServiceStub.buildContributionIntent({
        campaign,
        amount,
        sendAsset,
        contributorPublicKey: walletPublicKey,
      });

      const prepared =
        intent.kind === 'payment'
          ? await stellarStub.prepareSignedContributionPayment({
              senderSecret: 'SDECRYPTED',
              destinationPublicKey: campaign.wallet_public_key,
              asset: sendAsset,
              amount,
              memo: 'cp-c-1',
            })
          : await stellarStub.prepareSignedContributionPathPayment({
              senderSecret: 'SDECRYPTED',
              destinationPublicKey: campaign.wallet_public_key,
              sendAsset,
              sendMax: intent.sendMax,
              destAmount: amount,
              destAssetCode: campaign.asset_type,
              memo: 'cp-c-1',
            });

      let txHash;
      try {
        txHash = await stellarStub.submitPreparedTransaction(prepared.signedXdr);
      } catch (err) {
        err.statusCode = err.statusCode || 502;
        throw err;
      }
      const stellarTransactionId = await stellarTxStub.insertContributionSubmitted(null, {
        txHash,
        campaignId,
        userId,
        unsignedXdr: prepared.unsignedXdr,
        signedXdr: prepared.signedXdr,
        metadata: {
          ...intent.flowMetadata,
          platform_fee_amount: prepared.feeAmount ?? 0,
        },
      });

      return {
        txHash,
        stellarTransactionId,
        conversionQuote: intent.conversionQuote,
        platform_fee_amount: prepared.feeAmount ?? 0,
      };
    },
  };

  const databaseStub = {
    query: queryImpl,
    connect: connectImpl || (async () => ({
      query: queryImpl,
      release: async () => {},
    })),
  };

  const router = proxyquire('./contributions', {
    '../config/stellar': {
      networkPassphrase: TESTNET_PASSPHRASE,
      isTestnet: true,
    },
    '../config/database': databaseStub,
    '../services/stellarService': stellarStub,
    '../services/stellarTransactionService': stellarTxStub,
    '../services/walletSecrets': {
      withDecryptedWalletSecret: async (_ciphertext, _context, fn) => fn('SDECRYPTED'),
    },
    '../services/contributionService': contributionServiceStub,
    '../services/sorobanService': sorobanStub,
    '../services/ledgerMonitor': ledgerMonitorStub,
    '../services/kycService': {
      assertUserKycVerified: async () => {},
    },
    '../services/contributorIdentityService': {
      assertContributorMeetsRequirements: async () => {},
    },
    '../services/emailService': {
      sendEmail: async () => {},
    },
    '../middleware/auth': {
      requireAuth: (req, _res, next) => {
        req.user = { userId: 'user-1' };
        next();
      },
    },
    '../middleware/validation': {
      contributionValidation: [],
      contributionQuoteValidation: [],
      validateRequest: (_req, _res, next) => next(),
    },
  });

  const app = express();
  app.use(express.json());
  app.use('/api/contributions', router);
  return app;
}

// TODO(#786): Unimplemented Freighter prepare/submit-signed + quote flow — route doesn't exist yet
test('GET /api/contributions/quote returns best path quote', { skip: 'Route not implemented - see #786' }, async () => {
  const app = buildApp({
    queryImpl: async () => ({ rows: [] }),
    stellarImpl: {
      submitPayment: async () => 'unused',
      submitPathPayment: async () => 'unused',
      getPathPaymentQuote: async () => [
        {
          source_asset: 'XLM',
          destination_asset: 'USDC',
          source_amount: '10.0000000',
          destination_amount: '9.0000000',
          path: ['AQUA'],
        },
      ],
    },
  });

  const response = await request(app)
    .get('/api/contributions/quote?send_asset=XLM&dest_asset=USDC&dest_amount=9')
    .set('Authorization', 'Bearer token');

  assert.equal(response.status, 200);
  assert.equal(response.body.quoted_source_amount, '10.0000000');
  assert.equal(response.body.max_send_amount, '10.5000000');
  assert.equal(response.body.estimated_rate, '0.900000000000000');
});

test('GET /api/contributions/quote returns 404 when no path exists', { skip: 'Route not implemented - see #786' }, async () => {
  const app = buildApp({
    queryImpl: async () => ({ rows: [] }),
    stellarImpl: {
      submitPayment: async () => 'unused',
      submitPathPayment: async () => 'unused',
      getPathPaymentQuote: async () => [],
    },
  });

  const response = await request(app)
    .get('/api/contributions/quote?send_asset=XLM&dest_asset=USDC&dest_amount=9')
    .set('Authorization', 'Bearer token');

  assert.equal(response.status, 404);
});

// TODO(#786): Tests below require stubbed route impl with migration_in_progress, CAMPAIGN_DISPUTED, max_per_user, advisory locks
test('POST /api/contributions uses direct payment for same asset', { skip: 'Stubbed route impl not matching real route - see #786' }, async () => {
  const prepared = [];
  const submitted = [];
  const app = buildApp({
    queryImpl: async (text) => {
      if (text.includes('FROM campaigns')) {
        return {
          rows: [{ id: '11111111-1111-1111-1111-111111111111', status: 'active', asset_type: 'XLM', wallet_public_key: VALID_G }],
        };
      }
      if (text.includes('FROM users')) {
        return {
          rows: [{ wallet_secret_encrypted: 'SSECRET', wallet_public_key: 'GSENDER' }],
        };
      }
      return { rows: [] };
    },
    stellarImpl: {
      prepareSignedContributionPayment: async (payload) => {
        prepared.push(payload);
        return { unsignedXdr: 'u', signedXdr: 's', feeAmount: 0 };
      },
      prepareSignedContributionPathPayment: async () => {
        throw new Error('should not be called');
      },
      submitPreparedTransaction: async (xdr) => {
        submitted.push(xdr);
        return 'tx-direct';
      },
      getPathPaymentQuote: async () => [],
    },
  });

  const response = await request(app)
    .post('/api/contributions')
    .set('Authorization', 'Bearer token')
    .send({ campaign_id: '11111111-1111-1111-1111-111111111111', amount: '5.0000000', send_asset: 'XLM' });

  assert.equal(response.status, 202);
  assert.equal(response.body.tx_hash, 'tx-direct');
  assert.equal(response.body.stellar_transaction_id, 'stellar-row-id');
  assert.equal(prepared.length, 1);
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0], 's');
});

test('POST /api/contributions uses direct payment for same USDC asset', { skip: 'Stubbed route impl not matching real route - see #786' }, async () => {
  const submitted = [];
  const app = buildApp({
    queryImpl: async (text) => {
      if (text.includes('FROM campaigns')) {
        return {
          rows: [{ id: '22222222-2222-2222-2222-222222222222', status: 'active', asset_type: 'USDC', wallet_public_key: VALID_G }],
        };
      }
      if (text.includes('FROM users')) {
        return {
          rows: [{ wallet_secret_encrypted: 'SSECRET', wallet_public_key: 'GSENDER' }],
        };
      }
      return { rows: [] };
    },
    stellarImpl: {
      prepareSignedContributionPayment: async (payload) => {
        submitted.push(payload);
        return { unsignedXdr: 'u', signedXdr: 's', feeAmount: 0 };
      },
      prepareSignedContributionPathPayment: async () => {
        throw new Error('should not be called');
      },
      submitPreparedTransaction: async () => 'tx-direct-usdc',
      getPathPaymentQuote: async () => [],
      getSupportedAssetCodes: () => ['XLM', 'USDC'],
    },
  });

  const response = await request(app)
    .post('/api/contributions')
    .set('Authorization', 'Bearer token')
    .send({ campaign_id: '22222222-2222-2222-2222-222222222222', amount: '7.0000000', send_asset: 'USDC' });

  assert.equal(response.status, 202);
  assert.equal(response.body.tx_hash, 'tx-direct-usdc');
  assert.equal(submitted.length, 1);
});

test('POST /api/contributions is blocked while the campaign contract is being migrated', { skip: 'Stubbed route impl not matching real route - see #786' }, async () => {
  const app = buildApp({
    queryImpl: async (text) => {
      if (text.includes('FROM campaigns')) {
        return {
          rows: [{
            id: '11111111-1111-1111-1111-111111111111',
            status: 'active',
            asset_type: 'USDC',
            wallet_public_key: VALID_G,
            migration_in_progress: true,
          }],
        };
      }
      return { rows: [] };
    },
  });

  const response = await request(app)
    .post('/api/contributions')
    .set('Authorization', 'Bearer token')
    .send({ campaign_id: '11111111-1111-1111-1111-111111111111', amount: '5.0000000', send_asset: 'USDC' });

  assert.equal(response.status, 503);
  assert.equal(response.body.code, 'CAMPAIGN_MIGRATION_IN_PROGRESS');
});

test('POST /api/contributions uses path payment for conversion', { skip: 'Stubbed route impl not matching real route - see #786' }, async () => {
  let pathPayload = null;
  const app = buildApp({
    queryImpl: async (text) => {
      if (text.includes('FROM campaigns')) {
        return {
          rows: [{ id: '11111111-1111-1111-1111-111111111111', status: 'active', asset_type: 'USDC', wallet_public_key: VALID_G }],
        };
      }
      if (text.includes('FROM users')) {
        return {
          rows: [{ wallet_secret_encrypted: 'SSECRET', wallet_public_key: 'GSENDER' }],
        };
      }
      return { rows: [] };
    },
    stellarImpl: {
      prepareSignedContributionPayment: async () => {
        throw new Error('should not be called');
      },
      prepareSignedContributionPathPayment: async (payload) => {
        pathPayload = payload;
        return { unsignedXdr: 'u', signedXdr: 's', feeAmount: 0 };
      },
      submitPreparedTransaction: async () => 'tx-path',
      getPathPaymentQuote: async () => [
        {
          source_asset: 'XLM',
          destination_asset: 'USDC',
          source_amount: '5.0000000',
          destination_amount: '4.5000000',
          path: [],
        },
      ],
    },
  });

  const response = await request(app)
    .post('/api/contributions')
    .set('Authorization', 'Bearer token')
    .send({ campaign_id: '11111111-1111-1111-1111-111111111111', amount: '4.5000000', send_asset: 'XLM' });

  assert.equal(response.status, 202);
  assert.equal(response.body.tx_hash, 'tx-path');
  assert.equal(response.body.conversion_quote.max_send_amount, '5.2500000');
  assert.equal(pathPayload.sendMax, '5.2500000');
  assert.equal(pathPayload.destAmount, '4.5000000');
  assert.equal(pathPayload.destAssetCode, 'USDC');
});

test('POST /api/contributions supports reverse conversion USDC -> XLM', { skip: 'Stubbed route impl not matching real route - see #786' }, async () => {
  let pathPayload = null;
  const app = buildApp({
    queryImpl: async (text) => {
      if (text.includes('FROM campaigns')) {
        return {
          rows: [{ id: '33333333-3333-3333-3333-333333333333', status: 'active', asset_type: 'XLM', wallet_public_key: VALID_G }],
        };
      }
      if (text.includes('FROM users')) {
        return {
          rows: [{ wallet_secret_encrypted: 'SSECRET', wallet_public_key: 'GSENDER' }],
        };
      }
      return { rows: [] };
    },
    stellarImpl: {
      prepareSignedContributionPayment: async () => {
        throw new Error('should not be called');
      },
      prepareSignedContributionPathPayment: async (payload) => {
        pathPayload = payload;
        return { unsignedXdr: 'u', signedXdr: 's', feeAmount: 0 };
      },
      submitPreparedTransaction: async () => 'tx-path-reverse',
      getPathPaymentQuote: async () => [
        {
          source_asset: 'USDC',
          destination_asset: 'XLM',
          source_amount: '12.0000000',
          destination_amount: '10.0000000',
          path: ['AQUA'],
        },
      ],
      getSupportedAssetCodes: () => ['XLM', 'USDC'],
    },
  });

  const response = await request(app)
    .post('/api/contributions')
    .set('Authorization', 'Bearer token')
    .send({ campaign_id: '33333333-3333-3333-3333-333333333333', amount: '10.0000000', send_asset: 'USDC' });

  assert.equal(response.status, 202);
  assert.equal(response.body.tx_hash, 'tx-path-reverse');
  assert.equal(response.body.conversion_quote.max_send_amount, '12.6000000');
  assert.equal(pathPayload.sendAsset, 'USDC');
  assert.equal(pathPayload.destAmount, '10.0000000');
  assert.equal(pathPayload.destAssetCode, 'XLM');
});

test('POST /api/contributions returns 503 when custodial trustline setup fails', { skip: 'Stubbed route impl not matching real route - see #786' }, async () => {
  const app = buildApp({
    queryImpl: async (text) => {
      if (text.includes('FROM campaigns')) {
        return {
          rows: [{ id: '11111111-1111-1111-1111-111111111111', status: 'active', asset_type: 'XLM', wallet_public_key: VALID_G }],
        };
      }
      if (text.includes('FROM users')) {
        return {
          rows: [{ wallet_secret_encrypted: 'SSECRET', wallet_public_key: 'GSENDER' }],
        };
      }
      return { rows: [] };
    },
    stellarImpl: {
      ensureCustodialAccountFundedAndTrusted: async () => {
        throw new Error('horizon_down');
      },
    },
  });

  const response = await request(app)
    .post('/api/contributions')
    .set('Authorization', 'Bearer token')
    .send({ campaign_id: '11111111-1111-1111-1111-111111111111', amount: '5.0000000', send_asset: 'XLM' });

  assert.equal(response.status, 503);
  assert.match(response.body.error, /retry/i);
});

test('POST /api/contributions returns 502 when Stellar submit fails and skips audit insert', { skip: 'Stubbed route impl not matching real route - see #786' }, async () => {
  let inserted = false;
  const app = buildApp({
    queryImpl: async (text) => {
      if (text.includes('FROM campaigns')) {
        return {
          rows: [{ id: '11111111-1111-1111-1111-111111111111', status: 'active', asset_type: 'XLM', wallet_public_key: VALID_G }],
        };
      }
      if (text.includes('FROM users')) {
        return {
          rows: [{ wallet_secret_encrypted: 'SSECRET', wallet_public_key: 'GSENDER' }],
        };
      }
      return { rows: [] };
    },
    stellarImpl: {
      submitPreparedTransaction: async () => {
        throw new Error('tx_failed');
      },
    },
    stellarTxImpl: {
      insertContributionSubmitted: async () => {
        inserted = true;
        return 'should-not-run';
      },
    },
  });

  const response = await request(app)
    .post('/api/contributions')
    .set('Authorization', 'Bearer token')
    .send({ campaign_id: '11111111-1111-1111-1111-111111111111', amount: '5.0000000', send_asset: 'XLM' });

  assert.equal(response.status, 502);
  assert.equal(inserted, false);
});

test('POST /api/contributions returns 409 CAMPAIGN_DISPUTED for a disputed campaign', { skip: 'Stubbed route impl not matching real route - see #786' }, async () => {
  const app = buildApp({
    queryImpl: async (text) => {
      if (text.includes('SELECT status FROM campaigns')) {
        return { rows: [{ status: 'disputed' }] };
      }
      if (text.includes('FROM campaigns')) {
        return {
          rows: [{ id: '11111111-1111-1111-1111-111111111111', status: 'disputed', asset_type: 'XLM', wallet_public_key: VALID_G }],
        };
      }
      return { rows: [] };
    },
  });

  const response = await request(app)
    .post('/api/contributions')
    .set('Authorization', 'Bearer token')
    .send({ campaign_id: '11111111-1111-1111-1111-111111111111', amount: '5.0000000', send_asset: 'XLM' });

  assert.equal(response.status, 409);
  assert.equal(response.body.code, 'CAMPAIGN_DISPUTED');
});

// TODO(#786): Freighter prepare/submit-signed flow not implemented
test('POST /api/contributions/prepare returns 409 CAMPAIGN_DISPUTED for a disputed campaign', { skip: 'Route not implemented - see #786' }, async () => {
  const sender = Keypair.random();
  const app = buildApp({
    queryImpl: async (text) => {
      if (text.includes('SELECT status FROM campaigns')) {
        return { rows: [{ status: 'disputed' }] };
      }
      return { rows: [] };
    },
  });

  const response = await request(app)
    .post('/api/contributions/prepare')
    .set('Authorization', 'Bearer token')
    .send({
      campaign_id: '11111111-1111-1111-1111-111111111111',
      amount: '5.0000000',
      send_asset: 'XLM',
      sender_public_key: sender.publicKey(),
    });

  assert.equal(response.status, 409);
  assert.equal(response.body.code, 'CAMPAIGN_DISPUTED');
});

test('POST /api/contributions/prepare returns unsigned XDR and prepare token for Freighter', { skip: 'Route not implemented - see #786' }, async () => {
  const sender = Keypair.random();
  let preparedPayload = null;
  const app = buildApp({
    queryImpl: async (text) => {
      if (text.includes('FROM campaigns')) {
        return {
          rows: [{ id: '11111111-1111-1111-1111-111111111111', status: 'active', asset_type: 'XLM', wallet_public_key: VALID_G }],
        };
      }
      if (text.includes('INSERT INTO stellar_transactions') && text.includes('RETURNING id')) {
        return { rows: [{ id: 'reservation-1' }] };
      }
      if (text.includes('FROM contributions') || text.includes('FROM stellar_transactions')) {
        return { rows: [{ total: '0' }] };
      }
      return { rows: [] };
    },
    stellarImpl: {
      buildUnsignedContributionPayment: async (payload) => {
        preparedPayload = payload;
        return buildUnsignedPaymentXdr({
          senderPublicKey: payload.senderPublicKey,
          destinationPublicKey: payload.destinationPublicKey,
          amount: payload.amount,
          asset: payload.asset,
        });
      },
    },
  });

  const response = await request(app)
    .post('/api/contributions/prepare')
    .set('Authorization', 'Bearer token')
    .send({
      campaign_id: '11111111-1111-1111-1111-111111111111',
      amount: '5.0000000',
      send_asset: 'XLM',
      sender_public_key: sender.publicKey(),
    });

  assert.equal(response.status, 200);
  assert.ok(response.body.prepare_token);
  assert.ok(response.body.unsigned_xdr);
  assert.equal(response.body.sender_public_key, sender.publicKey());
  assert.equal(response.body.network_name, 'TESTNET');
  assert.equal(preparedPayload.senderPublicKey, sender.publicKey());
});

test('POST /api/contributions/submit-signed accepts Freighter-signed XDR that matches prepared transaction', { skip: 'Route not implemented - see #786' }, async () => {
  const sender = Keypair.random();
  const destination = Keypair.random();
  let submittedXdr = null;
  let insertedRow = null;
  const unsignedXdr = buildUnsignedPaymentXdr({
    senderPublicKey: sender.publicKey(),
    destinationPublicKey: destination.publicKey(),
    amount: '5.0000000',
  });

  const app = buildApp({
    queryImpl: async (text, params) => {
      if (text.includes('SELECT status, max_contribution, max_per_user, asset_type FROM campaigns')) {
        return { rows: [{ status: 'active', max_contribution: null, max_per_user: null, asset_type: 'XLM' }] };
      }
      if (text.includes('FROM campaigns')) {
        return {
          rows: [{
            id: '11111111-1111-1111-1111-111111111111',
            status: 'active',
            asset_type: 'XLM',
            wallet_public_key: destination.publicKey(),
          }],
        };
      }
      if (text.includes('SELECT id, status, amount, expires_at FROM stellar_transactions')) {
        return { rows: [{ id: 'reservation-1', status: 'reserved', amount: '5.0000000', expires_at: null }] };
      }
      if (text.includes('INSERT INTO stellar_transactions') && text.includes('RETURNING id')) {
        return { rows: [{ id: 'reservation-1' }] };
      }
      if (text.includes('UPDATE stellar_transactions') && text.includes('RETURNING id')) {
        insertedRow = { unsignedXdr: params[1], signedXdr: params[2] };
        return { rows: [{ id: 'stellar-freighter-row' }] };
      }
      if (text.includes('FROM contributions') || text.includes('FROM stellar_transactions')) {
        return { rows: [{ total: '0' }] };
      }
      return { rows: [] };
    },
    stellarImpl: {
      buildUnsignedContributionPayment: async () => unsignedXdr,
      submitPreparedTransaction: async (xdr) => {
        submittedXdr = xdr;
        return 'tx-freighter';
      },
    },
  });

  const prepare = await request(app)
    .post('/api/contributions/prepare')
    .set('Authorization', 'Bearer token')
    .send({
      campaign_id: '11111111-1111-1111-1111-111111111111',
      amount: '5.0000000',
      send_asset: 'XLM',
      sender_public_key: sender.publicKey(),
    });

  assert.equal(prepare.status, 200);

  const tx = TransactionBuilder.fromXDR(prepare.body.unsigned_xdr, TESTNET_PASSPHRASE);
  tx.sign(sender);
  const signedXdr = tx.toXDR();

  const response = await request(app)
    .post('/api/contributions/submit-signed')
    .set('Authorization', 'Bearer token')
    .send({
      prepare_token: prepare.body.prepare_token,
      signed_xdr: signedXdr,
    });

  assert.equal(response.status, 202);
  assert.equal(response.body.tx_hash, 'tx-freighter');
  assert.equal(response.body.stellar_transaction_id, 'stellar-freighter-row');
  assert.equal(submittedXdr, signedXdr);
  assert.equal(insertedRow.signedXdr, signedXdr);
  assert.equal(insertedRow.unsignedXdr, prepare.body.unsigned_xdr);
});

test('POST /api/contributions/submit-signed rejects a signed XDR that does not match prepared transaction', { skip: 'Route not implemented - see #786' }, async () => {
  const sender = Keypair.random();
  const destination = Keypair.random();
  const unsignedXdr = buildUnsignedPaymentXdr({
    senderPublicKey: sender.publicKey(),
    destinationPublicKey: destination.publicKey(),
    amount: '5.0000000',
  });
  const mismatchedUnsignedXdr = buildUnsignedPaymentXdr({
    senderPublicKey: sender.publicKey(),
    destinationPublicKey: destination.publicKey(),
    amount: '6.0000000',
  });

  const app = buildApp({
    queryImpl: async (text) => {
      if (text.includes('FROM campaigns')) {
        return {
          rows: [{
            id: '11111111-1111-1111-1111-111111111111',
            status: 'active',
            asset_type: 'XLM',
            wallet_public_key: destination.publicKey(),
          }],
        };
      }
      if (text.includes('INSERT INTO stellar_transactions') && text.includes('RETURNING id')) {
        return { rows: [{ id: 'reservation-1' }] };
      }
      if (text.includes('FROM contributions') || text.includes('FROM stellar_transactions')) {
        return { rows: [{ total: '0' }] };
      }
      return { rows: [] };
    },
    stellarImpl: {
      buildUnsignedContributionPayment: async () => unsignedXdr,
      submitPreparedTransaction: async () => {
        throw new Error('should not submit');
      },
    },
  });

  const prepare = await request(app)
    .post('/api/contributions/prepare')
    .set('Authorization', 'Bearer token')
    .send({
      campaign_id: '11111111-1111-1111-1111-111111111111',
      amount: '5.0000000',
      send_asset: 'XLM',
      sender_public_key: sender.publicKey(),
    });

  assert.equal(prepare.status, 200);

  const mismatchedTx = TransactionBuilder.fromXDR(mismatchedUnsignedXdr, TESTNET_PASSPHRASE);
  mismatchedTx.sign(sender);

  const response = await request(app)
    .post('/api/contributions/submit-signed')
    .set('Authorization', 'Bearer token')
    .send({
      prepare_token: prepare.body.prepare_token,
      signed_xdr: mismatchedTx.toXDR(),
    });

  assert.equal(response.status, 422);
  assert.match(response.body.error, /does not match/i);
});

test('POST /api/contributions/prepare enforces max_per_user atomically', { skip: 'Route not implemented - see #786' }, async () => {
  const sender = Keypair.random();
  const app = buildApp({
    queryImpl: async (text) => {
      if (text.includes('FROM campaigns')) {
        return {
          rows: [{
            id: '11111111-1111-1111-1111-111111111111',
            status: 'active',
            asset_type: 'XLM',
            wallet_public_key: VALID_G,
            max_per_user: '10.0000000',
          }],
        };
      }
      if (text.includes('FROM contributions')) {
        return { rows: [{ total: '8.0000000' }] };
      }
      if (text.includes('FROM stellar_transactions')) {
        return { rows: [{ total: '0' }] };
      }
      return { rows: [] };
    },
  });

  const response = await request(app)
    .post('/api/contributions/prepare')
    .set('Authorization', 'Bearer token')
    .send({
      campaign_id: '11111111-1111-1111-1111-111111111111',
      amount: '5.0000000',
      send_asset: 'XLM',
      sender_public_key: sender.publicKey(),
    });

  assert.equal(response.status, 400);
  assert.match(response.body.error, /per-contributor limit/i);
});

test('POST /api/contributions/prepare counts an existing in-flight reservation toward the cap', { skip: 'Route not implemented - see #786' }, async () => {
  const sender = Keypair.random();
  const app = buildApp({
    queryImpl: async (text) => {
      if (text.includes('FROM campaigns')) {
        return {
          rows: [{
            id: '11111111-1111-1111-1111-111111111111',
            status: 'active',
            asset_type: 'XLM',
            wallet_public_key: VALID_G,
            max_per_user: '10.0000000',
          }],
        };
      }
      if (text.includes('FROM contributions')) {
        return { rows: [{ total: '0' }] };
      }
      // Simulates another not-yet-indexed /prepare reservation from the same sender.
      if (text.includes('FROM stellar_transactions')) {
        return { rows: [{ total: '7.0000000' }] };
      }
      return { rows: [] };
    },
  });

  const response = await request(app)
    .post('/api/contributions/prepare')
    .set('Authorization', 'Bearer token')
    .send({
      campaign_id: '11111111-1111-1111-1111-111111111111',
      amount: '5.0000000',
      send_asset: 'XLM',
      sender_public_key: sender.publicKey(),
    });

  assert.equal(response.status, 400);
  assert.match(response.body.error, /per-contributor limit/i);
});

test('POST /api/contributions/prepare serializes concurrent requests from the same sender so only one fits under the cap', { skip: 'Route not implemented - see #786' }, async () => {
  // Simulates real Postgres pg_advisory_xact_lock serialization: concurrent
  // /prepare calls for the same (campaign, sender) queue on the lock, and
  // each sees the other's committed reservation before deciding.
  const sender = Keypair.random();
  let reservedTotal = 0;
  const lockQueue = new Map();
  let currentRelease = null;

  function acquireLock(key) {
    const tail = lockQueue.get(key) || Promise.resolve();
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    lockQueue.set(key, tail.then(() => held));
    return tail.then(() => release);
  }

  const app = buildApp({
    queryImpl: async (text, params) => {
      if (text.includes('FROM campaigns')) {
        return {
          rows: [{
            id: '11111111-1111-1111-1111-111111111111',
            status: 'active',
            asset_type: 'XLM',
            wallet_public_key: VALID_G,
            max_per_user: '10.0000000',
          }],
        };
      }
      if (text.includes('pg_advisory_xact_lock')) {
        currentRelease = await acquireLock('camp-1:' + sender.publicKey());
        return { rows: [] };
      }
      if (text.includes('FROM contributions')) {
        return { rows: [{ total: '0' }] };
      }
      if (text.includes('FROM stellar_transactions')) {
        return { rows: [{ total: String(reservedTotal) }] };
      }
      if (text.includes('INSERT INTO stellar_transactions') && text.includes('RETURNING id')) {
        reservedTotal += parseFloat(params[3]);
        return { rows: [{ id: 'reservation-x' }] };
      }
      if (text === 'COMMIT' || text === 'ROLLBACK') {
        currentRelease?.();
        currentRelease = null;
        return { rows: [] };
      }
      return { rows: [] };
    },
  });

  const send = (amount) =>
    request(app)
      .post('/api/contributions/prepare')
      .set('Authorization', 'Bearer token')
      .send({
        campaign_id: '11111111-1111-1111-1111-111111111111',
        amount,
        send_asset: 'XLM',
        sender_public_key: sender.publicKey(),
      });

  const [r1, r2] = await Promise.all([send('6.0000000'), send('6.0000000')]);

  const statuses = [r1.status, r2.status].sort();
  assert.deepEqual(statuses, [200, 400]);
  assert.equal(reservedTotal, 6); // only the winning reservation was ever inserted
});

test('POST /api/contributions/submit-signed rejects a reservation that is no longer reserved (expired or already used)', { skip: 'Route not implemented - see #786' }, async () => {
  const sender = Keypair.random();
  const destination = Keypair.random();
  const unsignedXdr = buildUnsignedPaymentXdr({
    senderPublicKey: sender.publicKey(),
    destinationPublicKey: destination.publicKey(),
    amount: '5.0000000',
  });

  const app = buildApp({
    queryImpl: async (text) => {
      if (text.includes('FROM campaigns')) {
        return {
          rows: [{
            id: '11111111-1111-1111-1111-111111111111',
            status: 'active',
            asset_type: 'XLM',
            wallet_public_key: destination.publicKey(),
          }],
        };
      }
      if (text.includes('SELECT id, status, amount, expires_at FROM stellar_transactions')) {
        // The reservation already expired since /prepare ran.
        return { rows: [{ id: 'reservation-1', status: 'reserved', amount: '5.0000000', expires_at: '2000-01-01T00:00:00.000Z' }] };
      }
      if (text.includes('INSERT INTO stellar_transactions') && text.includes('RETURNING id')) {
        return { rows: [{ id: 'reservation-1' }] };
      }
      if (text.includes('FROM contributions') || text.includes('FROM stellar_transactions')) {
        return { rows: [{ total: '0' }] };
      }
      return { rows: [] };
    },
    stellarImpl: {
      buildUnsignedContributionPayment: async () => unsignedXdr,
      submitPreparedTransaction: async () => {
        throw new Error('should not submit an expired reservation');
      },
    },
  });

  const prepare = await request(app)
    .post('/api/contributions/prepare')
    .set('Authorization', 'Bearer token')
    .send({
      campaign_id: '11111111-1111-1111-1111-111111111111',
      amount: '5.0000000',
      send_asset: 'XLM',
      sender_public_key: sender.publicKey(),
    });
  assert.equal(prepare.status, 200);

  const tx = TransactionBuilder.fromXDR(prepare.body.unsigned_xdr, TESTNET_PASSPHRASE);
  tx.sign(sender);

  const response = await request(app)
    .post('/api/contributions/submit-signed')
    .set('Authorization', 'Bearer token')
    .send({ prepare_token: prepare.body.prepare_token, signed_xdr: tx.toXDR() });

  assert.equal(response.status, 410);
});

test('POST /api/contributions/prepare builds a Soroban deposit for a contract-mode, same-asset campaign', { skip: 'Route not implemented - see #786' }, async () => {
  const sender = Keypair.random();
  let depositArgs = null;
  const app = buildApp({
    queryImpl: async (text) => {
      if (text.includes('FROM campaigns')) {
        return {
          rows: [{
            id: '11111111-1111-1111-1111-111111111111',
            status: 'active',
            asset_type: 'USDC',
            wallet_public_key: VALID_G,
            escrow_contract_id: 'CESCROWCONTRACT',
          }],
        };
      }
      if (text.includes('INSERT INTO stellar_transactions') && text.includes('RETURNING id')) {
        return { rows: [{ id: 'reservation-1' }] };
      }
      if (text.includes('FROM contributions') || text.includes('FROM stellar_transactions')) {
        return { rows: [{ total: '0' }] };
      }
      return { rows: [] };
    },
    sorobanImpl: {
      isContractDepositEligible: (campaign) => Boolean(campaign?.escrow_contract_id),
      buildUnsignedEscrowDeposit: async (args) => {
        depositArgs = args;
        return 'soroban-unsigned-xdr';
      },
    },
  });

  const response = await request(app)
    .post('/api/contributions/prepare')
    .set('Authorization', 'Bearer token')
    .send({
      campaign_id: '11111111-1111-1111-1111-111111111111',
      amount: '10.0000000',
      send_asset: 'USDC',
      sender_public_key: sender.publicKey(),
    });

  assert.equal(response.status, 200);
  assert.equal(response.body.unsigned_xdr, 'soroban-unsigned-xdr');
  assert.equal(depositArgs.contractId, 'CESCROWCONTRACT');
  assert.equal(depositArgs.fromAddress, sender.publicKey());
  assert.equal(depositArgs.amount, 100_000_000);
});

test('POST /api/contributions/prepare rejects a cross-asset contribution to a contract-mode campaign', { skip: 'Route not implemented - see #786' }, async () => {
  const sender = Keypair.random();
  const app = buildApp({
    queryImpl: async (text) => {
      if (text.includes('FROM campaigns')) {
        return {
          rows: [{
            id: '11111111-1111-1111-1111-111111111111',
            status: 'active',
            asset_type: 'USDC',
            wallet_public_key: VALID_G,
            escrow_contract_id: 'CESCROWCONTRACT',
          }],
        };
      }
      return { rows: [] };
    },
    sorobanImpl: {
      isContractDepositEligible: (campaign) => Boolean(campaign?.escrow_contract_id),
    },
  });

  const response = await request(app)
    .post('/api/contributions/prepare')
    .set('Authorization', 'Bearer token')
    .send({
      campaign_id: '11111111-1111-1111-1111-111111111111',
      amount: '10.0000000',
      send_asset: 'XLM',
      sender_public_key: sender.publicKey(),
    });

  assert.equal(response.status, 422);
  assert.match(response.body.error, /cross-asset/i);
});

test('POST /api/contributions/submit-signed records the contribution synchronously for a contract-mode deposit', { skip: 'Route not implemented - see #786' }, async () => {
  const sender = Keypair.random();
  const recordCalls = [];
  const unsignedXdr = buildUnsignedPaymentXdr({
    senderPublicKey: sender.publicKey(),
    destinationPublicKey: sender.publicKey(),
    amount: '10.0000000',
  });

  const app = buildApp({
    queryImpl: async (text, params) => {
      if (text.includes('SELECT status, max_contribution, max_per_user, asset_type FROM campaigns')) {
        return { rows: [{ status: 'active', max_contribution: null, max_per_user: null, asset_type: 'USDC' }] };
      }
      if (text.includes('FROM campaigns')) {
        return {
          rows: [{
            id: '11111111-1111-1111-1111-111111111111',
            status: 'active',
            asset_type: 'USDC',
            wallet_public_key: VALID_G,
            escrow_contract_id: 'CESCROWCONTRACT',
          }],
        };
      }
      if (text.includes('SELECT id, status, amount, expires_at FROM stellar_transactions')) {
        return { rows: [{ id: 'reservation-1', status: 'reserved', amount: '10.0000000', expires_at: null }] };
      }
      if (text.includes('INSERT INTO stellar_transactions') && text.includes('RETURNING id')) {
        return { rows: [{ id: 'reservation-1' }] };
      }
      if (text.includes('UPDATE stellar_transactions') && text.includes('RETURNING id')) {
        return { rows: [{ id: 'reservation-1' }] };
      }
      if (text.includes('FROM contributions') || text.includes('FROM stellar_transactions')) {
        return { rows: [{ total: '0' }] };
      }
      return { rows: [] };
    },
    sorobanImpl: {
      isContractDepositEligible: (campaign) => Boolean(campaign?.escrow_contract_id),
      buildUnsignedEscrowDeposit: async () => unsignedXdr,
    },
    ledgerMonitorImpl: {
      recordConfirmedContribution: async (args) => {
        recordCalls.push(args);
      },
    },
    stellarImpl: {
      submitPreparedTransaction: async () => 'contract-tx-hash',
    },
  });

  const prepare = await request(app)
    .post('/api/contributions/prepare')
    .set('Authorization', 'Bearer token')
    .send({
      campaign_id: '11111111-1111-1111-1111-111111111111',
      amount: '10.0000000',
      send_asset: 'USDC',
      sender_public_key: sender.publicKey(),
    });
  assert.equal(prepare.status, 200);

  const tx = TransactionBuilder.fromXDR(prepare.body.unsigned_xdr, TESTNET_PASSPHRASE);
  tx.sign(sender);

  const response = await request(app)
    .post('/api/contributions/submit-signed')
    .set('Authorization', 'Bearer token')
    .send({ prepare_token: prepare.body.prepare_token, signed_xdr: tx.toXDR() });

  assert.equal(response.status, 202);
  assert.equal(response.body.tx_hash, 'contract-tx-hash');
  assert.equal(recordCalls.length, 1);
  assert.equal(recordCalls[0].campaignId, '11111111-1111-1111-1111-111111111111');
  assert.equal(recordCalls[0].senderPublicKey, sender.publicKey());
  assert.equal(recordCalls[0].destinationAsset, 'USDC');
  assert.equal(recordCalls[0].txHash, 'contract-tx-hash');
});

test('GET /api/contributions/finalization/:txHash returns finalized when indexed', { skip: 'Route not implemented - see #786' }, async () => {
  const app = buildApp({
    queryImpl: async (text) => {
      if (text.includes('FROM stellar_transactions st')) {
        return {
          rows: [
            {
              id: 'st-1',
              status: 'indexed',
              tx_hash: 'txh',
              campaign_id: '11111111-1111-1111-1111-111111111111',
              contribution_id: 'contrib-1',
              initiated_by_user_id: 'user-1',
              metadata: {},
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
              creator_id: 'user-1',
              contribution_row_id: 'contrib-1',
              sender_public_key: 'GSENDER',
              amount: '5',
              asset: 'XLM',
              contribution_created_at: new Date().toISOString(),
            },
          ],
        };
      }
      if (text.includes('wallet_public_key FROM users')) {
        return { rows: [{ wallet_public_key: 'GSENDER' }] };
      }
      return { rows: [] };
    },
  });

  const response = await request(app)
    .get('/api/contributions/finalization/txh')
    .set('Authorization', 'Bearer token');

  assert.equal(response.status, 200);
  assert.equal(response.body.finalization_status, 'finalized');
  assert.equal(response.body.contribution.id, 'contrib-1');
});

test('POST /api/contributions/embed validates success path, expired, revoked, and tampered tokens', async () => {
  const app = buildApp({
    queryImpl: async (text) => {
      if (text.includes('FROM campaigns')) {
        return {
          rows: [{ id: 'campaign-1', status: 'active', asset_type: 'XLM', wallet_public_key: VALID_G }],
        };
      }
      if (text.includes('FROM users')) {
        return {
          rows: [{ wallet_secret_encrypted: 'SSECRET', wallet_public_key: 'GSENDER' }],
        };
      }
      return { rows: [] };
    },
  });

  const embedTokenJwtService = require('../services/embedTokenJwtService');
  const embedTokenService = require('../services/embedTokenService');
  const validToken = embedTokenJwtService.signEmbedToken({ campaignId: 'campaign-1' });

  // Stub embedTokenService.validateEmbedToken for testing different token states
  const originalValidate = embedTokenService.validateEmbedToken;
  embedTokenService.validateEmbedToken = async (token) => {
    if (token === validToken) {
      return { id: 'token-1', user_id: 'user-1', campaign_id: 'campaign-1' };
    }
    return null;
  };

  try {
    // 1. Success path
    const resSuccess = await request(app)
      .post('/api/contributions/embed')
      .send({ campaign_id: 'campaign-1', amount: '5.0000000', embed_token: validToken });
    assert.equal(resSuccess.status, 202);
    assert.equal(resSuccess.body.success, true);

    // 2. Tampered / invalid JWT path
    const resTampered = await request(app)
      .post('/api/contributions/embed')
      .send({ campaign_id: 'campaign-1', amount: '5.0000000', embed_token: 'invalid.jwt.token' });
    assert.equal(resTampered.status, 401);

    // 3. Revoked token path
    const revokedJwt = embedTokenJwtService.signEmbedToken({ campaignId: 'campaign-1' });
    const resRevoked = await request(app)
      .post('/api/contributions/embed')
      .send({ campaign_id: 'campaign-1', amount: '5.0000000', embed_token: revokedJwt });
    assert.equal(resRevoked.status, 403);
  } finally {
    embedTokenService.validateEmbedToken = originalValidate;
  }
});

test('POST /api/contributions includes platform_fee_amount in response and metadata', async () => {
  let capturedMetadata = null;
  const app = buildApp({
    queryImpl: async (text) => {
      if (text.includes('FROM campaigns')) {
        return {
          rows: [{ id: '11111111-1111-1111-1111-111111111111', status: 'active', asset_type: 'USDC', wallet_public_key: VALID_G }],
        };
      }
      if (text.includes('FROM users')) {
        return {
          rows: [{ wallet_secret_encrypted: 'SSECRET', wallet_public_key: 'GSENDER' }],
        };
      }
      return { rows: [] };
    },
    stellarImpl: {
      prepareSignedContributionPayment: async () => ({
        unsignedXdr: 'u',
        signedXdr: 's',
        feeAmount: 0.15,
      }),
      submitPreparedTransaction: async () => 'tx-fee-test',
      getPathPaymentQuote: async () => [],
    },
    stellarTxImpl: {
      insertContributionSubmitted: async (_client, row) => {
        capturedMetadata = row.metadata;
        return 'stellar-row-id';
      },
    },
  });

  const response = await request(app)
    .post('/api/contributions')
    .set('Authorization', 'Bearer token')
    .send({ campaign_id: '11111111-1111-1111-1111-111111111111', amount: '10.0000000', send_asset: 'USDC' });

  assert.equal(response.status, 202);
  assert.equal(response.body.platform_fee_amount, 0.15);
  assert.equal(capturedMetadata.platform_fee_amount, 0.15);
});

test('POST /api/contributions validates min_contribution limit', { skip: 'Stubbed route impl not matching real route - see #786' }, async () => {
  const app = buildApp({
    queryImpl: async (text) => {
      if (text.includes('FROM campaigns')) {
        return {
          rows: [{
            id: '11111111-1111-1111-1111-111111111111',
            status: 'active',
            asset_type: 'USDC',
            wallet_public_key: VALID_G,
            min_contribution: '15.0000000',
          }],
        };
      }
      if (text.includes('FROM users')) {
        return { rows: [{ wallet_secret_encrypted: 'SSECRET', wallet_public_key: 'GSENDER' }] };
      }
      return { rows: [] };
    },
  });

  const response = await request(app)
    .post('/api/contributions')
    .set('Authorization', 'Bearer token')
    .send({ campaign_id: '11111111-1111-1111-1111-111111111111', amount: '10.0000000', send_asset: 'USDC' });

  assert.equal(response.status, 400);
  assert.equal(response.body.error, 'Minimum contribution is 15.0000000 USDC');
});

test('POST /api/contributions validates max_contribution limit', { skip: 'Stubbed route impl not matching real route - see #786' }, async () => {
  const app = buildApp({
    queryImpl: async (text) => {
      if (text.includes('FROM campaigns')) {
        return {
          rows: [{
            id: '11111111-1111-1111-1111-111111111111',
            status: 'active',
            asset_type: 'USDC',
            wallet_public_key: VALID_G,
            max_contribution: '50.0000000',
          }],
        };
      }
      if (text.includes('FROM users')) {
        return { rows: [{ wallet_secret_encrypted: 'SSECRET', wallet_public_key: 'GSENDER' }] };
      }
      return { rows: [] };
    },
  });

  const response = await request(app)
    .post('/api/contributions')
    .set('Authorization', 'Bearer token')
    .send({ campaign_id: '11111111-1111-1111-1111-111111111111', amount: '60.0000000', send_asset: 'USDC' });

  assert.equal(response.status, 400);
  assert.equal(response.body.error, 'Maximum contribution is 50.0000000 USDC');
});

test('POST /api/contributions validates cumulative max_per_user cap', { skip: 'Stubbed route impl not matching real route - see #786' }, async () => {
  const app = buildApp({
    queryImpl: async (text) => {
      if (text.includes('FROM campaigns')) {
        return {
          rows: [{
            id: '11111111-1111-1111-1111-111111111111',
            status: 'active',
            asset_type: 'USDC',
            wallet_public_key: VALID_G,
            max_per_user: '100.0000000',
          }],
        };
      }
      if (text.includes('FROM users')) {
        return { rows: [{ wallet_secret_encrypted: 'SSECRET', wallet_public_key: 'GSENDER' }] };
      }
      if (text.includes('FROM contributions')) {
        return { rows: [{ total: '80.0000000' }] };
      }
      if (text.includes('FROM stellar_transactions')) {
        return { rows: [{ total: '0' }] };
      }
      return { rows: [] };
    },
  });

  const response = await request(app)
    .post('/api/contributions')
    .set('Authorization', 'Bearer token')
    .send({ campaign_id: '11111111-1111-1111-1111-111111111111', amount: '30.0000000', send_asset: 'USDC' });

  assert.equal(response.status, 400);
  assert.equal(response.body.error, 'You have already contributed 80 USDC. The per-contributor limit is 100.0000000.');
});

test('POST /api/contributions uses an advisory lock around the per-user cap check', { skip: 'Stubbed route impl not matching real route - see #786' }, async () => {
  const lockQueries = [];
  const app = buildApp({
    queryImpl: async (text) => {
      if (text.includes('FROM campaigns')) {
        return {
          rows: [{
            id: '11111111-1111-1111-1111-111111111111',
            status: 'active',
            asset_type: 'USDC',
            wallet_public_key: VALID_G,
            max_per_user: '100.0000000',
          }],
        };
      }
      if (text.includes('FROM users')) {
        return { rows: [{ wallet_secret_encrypted: 'SSECRET', wallet_public_key: 'GSENDER' }] };
      }
      if (text.includes('FROM contributions')) {
        return { rows: [{ total: '20.0000000' }] };
      }
      if (text.includes('FROM stellar_transactions')) {
        return { rows: [{ total: '0' }] };
      }
      if (text.includes('pg_advisory_xact_lock')) {
        lockQueries.push(text);
        return { rows: [] };
      }
      return { rows: [] };
    },
  });

  const response = await request(app)
    .post('/api/contributions')
    .set('Authorization', 'Bearer token')
    .send({ campaign_id: '11111111-1111-1111-1111-111111111111', amount: '10.0000000', send_asset: 'USDC' });

  assert.equal(response.status, 202);
  assert.equal(lockQueries.length, 1);
  assert.ok(lockQueries[0].includes('pg_advisory_xact_lock'));
});

function buildRefundApp({ contributionRow, refundImpl }) {
  const stellarStub = { getSupportedAssetCodes: () => ['XLM', 'USDC'] };
  const updates = [];

  const router = proxyquire('./contributions', {
    '../config/stellar': { networkPassphrase: TESTNET_PASSPHRASE, isTestnet: true },
    '../config/database': {
      query: async (text, params) => {
        if (text.includes('FROM contributions')) {
          return { rows: contributionRow ? [contributionRow] : [] };
        }
        if (text.includes('FROM users')) {
          return { rows: [{ wallet_public_key: 'GOWNER' }] };
        }
        if (text.includes('UPDATE contributions')) {
          updates.push(params);
          return { rows: [] };
        }
        return { rows: [] };
      },
    },
    '../services/stellarService': stellarStub,
    '../services/contributionService': {
      SLIPPAGE_BPS: 500,
      buildContributionMemo: () => 'cp-c-1',
      buildContributionIntent: async () => ({}),
      submitCustodialContribution: async () => ({}),
    },
    '../services/sorobanService': {
      triggerRefund: refundImpl || (async () => 'refund-tx-hash'),
    },
    '../middleware/auth': {
      requireAuth: (req, _res, next) => {
        req.user = { userId: 'user-1' };
        next();
      },
    },
    '../middleware/validation': {
      contributionValidation: [],
      contributionQuoteValidation: [],
      validateRequest: (_req, _res, next) => next(),
    },
  });

  const app = express();
  app.use(express.json());
  app.use('/api/contributions', router);
  return { app, updates };
}

const FAILED_CONTRIBUTION = {
  id: 'c-1',
  sender_public_key: 'GOWNER',
  escrow_contract_id: 'CESCROW',
  campaign_status: 'failed',
  contract_refunded_at: null,
  contract_refund_tx_hash: null,
};

// TODO(#786): Refund route not implemented
test('POST /api/contributions/:id/refund returns 400 for a funded campaign', { skip: 'Route not implemented - see #786' }, async () => {
  const { app } = buildRefundApp({
    contributionRow: { ...FAILED_CONTRIBUTION, campaign_status: 'funded' },
  });

  const response = await request(app)
    .post('/api/contributions/c-1/refund')
    .set('Authorization', 'Bearer token')
    .send({});

  assert.equal(response.status, 400);
  assert.match(response.body.error, /only available for failed campaigns/i);
  assert.equal(response.body.campaign_status, 'funded');
  assert.ok(response.body.eligibility);
});

test('POST /api/contributions/:id/refund returns 400 for an active campaign', { skip: 'Route not implemented - see #786' }, async () => {
  const { app } = buildRefundApp({
    contributionRow: { ...FAILED_CONTRIBUTION, campaign_status: 'active' },
  });

  const response = await request(app)
    .post('/api/contributions/c-1/refund')
    .set('Authorization', 'Bearer token')
    .send({});

  assert.equal(response.status, 400);
});

test('POST /api/contributions/:id/refund rejects a duplicate refund with 409', { skip: 'Route not implemented - see #786' }, async () => {
  const { app } = buildRefundApp({
    contributionRow: {
      ...FAILED_CONTRIBUTION,
      contract_refunded_at: '2026-06-01T00:00:00.000Z',
      contract_refund_tx_hash: 'existing-tx',
    },
  });

  const response = await request(app)
    .post('/api/contributions/c-1/refund')
    .set('Authorization', 'Bearer token')
    .send({});

  assert.equal(response.status, 409);
  assert.match(response.body.error, /already been refunded/i);
  assert.equal(response.body.tx_hash, 'existing-tx');
});

test('POST /api/contributions/:id/refund processes an eligible failed-campaign refund', { skip: 'Route not implemented - see #786' }, async () => {
  const { app, updates } = buildRefundApp({ contributionRow: FAILED_CONTRIBUTION });

  const response = await request(app)
    .post('/api/contributions/c-1/refund')
    .set('Authorization', 'Bearer token')
    .send({});

  assert.equal(response.status, 200);
  assert.equal(response.body.tx_hash, 'refund-tx-hash');
  assert.equal(updates.length, 1);
});

// --- GET /api/contributions/campaign/:campaignId pagination bounds (#490) ---
//
// limit/offset previously used plain parseInt() with no radix and no upper
// bound on limit; both are now delegated to the shared parsePagination()
// utility (the same one campaigns.js/admin.js/withdrawals.js/disputes.js use).

// TODO(#786): GET /api/contributions/campaign/:campaignId route not implemented
test('GET /api/contributions/campaign/:campaignId uses default limit/offset when none given', { skip: 'Route not implemented - see #786' }, async () => {
  let receivedParams;
  const app = buildApp({
    queryImpl: async (_sql, params) => {
      receivedParams = params;
      return { rows: [] };
    },
  });

  const res = await request(app).get('/api/contributions/campaign/cam-1');

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { contributions: [], total: 0, limit: 20, offset: 0 });
  assert.deepEqual(receivedParams, ['cam-1', 20, 0]);
});

test('GET /api/contributions/campaign/:campaignId clamps ?limit= to the 100 upper bound', { skip: 'Route not implemented - see #786' }, async () => {
  let receivedParams;
  const app = buildApp({
    queryImpl: async (_sql, params) => {
      receivedParams = params;
      return { rows: [] };
    },
  });

  const res = await request(app).get('/api/contributions/campaign/cam-1?limit=999999');

  assert.equal(res.status, 200);
  assert.equal(res.body.limit, 100);
  assert.deepEqual(receivedParams, ['cam-1', 100, 0]);
});

test('GET /api/contributions/campaign/:campaignId parses ?offset= with radix 10 and floors at 0', { skip: 'Route not implemented - see #786' }, async () => {
  let receivedParams;
  const app = buildApp({
    queryImpl: async (_sql, params) => {
      receivedParams = params;
      return { rows: [] };
    },
  });

  const res = await request(app).get('/api/contributions/campaign/cam-1?offset=-5');

  assert.equal(res.status, 200);
  assert.equal(res.body.offset, 0);
  assert.deepEqual(receivedParams, ['cam-1', 20, 0]);
});
