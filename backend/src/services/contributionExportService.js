const { once } = require('events');

const EXPORT_COLUMNS = [
  'contributor_name',
  'display_name',
  'amount_usd',
  'amount_xlm',
  'tier',
  'contributed_at',
  'wallet_address',
];
const DEFAULT_BATCH_SIZE = 500;

function normalizeAsset(asset) {
  return String(asset || '').trim().toUpperCase();
}

function amountForAsset(row, acceptedAssets) {
  if (acceptedAssets.includes(normalizeAsset(row.asset))) return row.amount ?? '';
  if (acceptedAssets.includes(normalizeAsset(row.source_asset))) return row.source_amount ?? '';
  return '';
}

function formatCsvTimestamp(value) {
  if (!value) return '';
  if (value instanceof Date) return value.toISOString();

  const date = new Date(value);
  if (!Number.isNaN(date.getTime())) return date.toISOString();
  return String(value);
}

function neutralizeFormulaPrefix(value) {
  return /^[=+\-@]/.test(value) ? `'${value}` : value;
}

function csvCell(value) {
  const raw = value === null || value === undefined ? '' : String(value);
  const text = neutralizeFormulaPrefix(raw);
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function csvRow(values) {
  return `${values.map(csvCell).join(',')}\n`;
}

function buildContributionExportRow(row) {
  const displayName = String(row.display_name || '').trim();
  const publicContributor = displayName.length > 0;
  const contributorPrivacy = row.contributor_privacy || 'full';

  // Apply contributor privacy settings to export
  // Anonymous: hide name and wallet, show only aggregate data
  if (contributorPrivacy === 'anonymous') {
    return [
      '', // contributor_name
      '', // display_name
      amountForAsset(row, ['USDC', 'USD']),
      amountForAsset(row, ['XLM']),
      row.tier || '',
      formatCsvTimestamp(row.created_at),
      '', // wallet_address
    ];
  }

  // Amount only: hide name and wallet, show amounts
  if (contributorPrivacy === 'amount_only') {
    return [
      '', // contributor_name
      '', // display_name
      amountForAsset(row, ['USDC', 'USD']),
      amountForAsset(row, ['XLM']),
      row.tier || '',
      formatCsvTimestamp(row.created_at),
      '', // wallet_address
    ];
  }

  // Full: show everything (existing behavior)
  return [
    publicContributor ? row.contributor_name || '' : '',
    displayName,
    amountForAsset(row, ['USDC', 'USD']),
    amountForAsset(row, ['XLM']),
    row.tier || '',
    formatCsvTimestamp(row.created_at),
    publicContributor ? row.sender_public_key || '' : '',
  ];
}

async function writeCsv(res, line) {
  if (res.destroyed || res.writableEnded) return false;
  if (!res.write(line)) {
    await once(res, 'drain');
  }
  return true;
}

function exportFilename(campaignId) {
  const safeId = String(campaignId).replace(/[^a-zA-Z0-9_-]/g, '_');
  return `campaign-${safeId}-contributors.csv`;
}

async function streamCampaignContributionExport({
  campaignId,
  res,
  runner,
  batchSize = DEFAULT_BATCH_SIZE,
}) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${exportFilename(campaignId)}"`
  );
  res.setHeader('Cache-Control', 'no-store');

  await writeCsv(res, csvRow(EXPORT_COLUMNS));

  let offset = 0;
  while (!res.destroyed && !res.writableEnded) {
    const { rows } = await runner.query(
      `SELECT ctr.display_name,
              ctr.sender_public_key,
              ctr.amount,
              ctr.asset,
              ctr.source_amount,
              ctr.source_asset,
              ctr.created_at,
              CASE
                WHEN NULLIF(BTRIM(ctr.display_name), '') IS NULL THEN NULL
                ELSE u.name
              END AS contributor_name,
              COALESCE(u.contributor_privacy, 'full') AS contributor_privacy,
              rt.title AS tier
         FROM contributions ctr
         LEFT JOIN users u ON u.wallet_public_key = ctr.sender_public_key
         LEFT JOIN contribution_rewards cr ON cr.contribution_id = ctr.id
         LEFT JOIN reward_tiers rt ON rt.id = cr.reward_tier_id
        WHERE ctr.campaign_id = $1
        ORDER BY ctr.created_at ASC, ctr.id ASC
        LIMIT $2 OFFSET $3`,
      [campaignId, batchSize, offset]
    );

    if (!rows.length) break;

    for (const row of rows) {
      const shouldContinue = await writeCsv(res, csvRow(buildContributionExportRow(row)));
      if (!shouldContinue) break;
    }

    offset += rows.length;
    if (rows.length < batchSize) break;
  }

  if (!res.destroyed && !res.writableEnded) {
    res.end();
  }
}

module.exports = {
  EXPORT_COLUMNS,
  buildContributionExportRow,
  csvCell,
  streamCampaignContributionExport,
};
