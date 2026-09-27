import { useState, useEffect } from 'react';
import { Navigate, Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { stellarExpertAccountUrl } from '../config/stellar';
import VerificationBadge from '../components/VerificationBadge';
import KycPrompt from '../components/KycPrompt';
import ContributorBadges from '../components/ContributorBadges';
import { api } from '../services/api';
import {
  isCreatorChecklistDismissed,
  restoreCreatorChecklist,
  dismissCreatorChecklist,
} from '../lib/onboarding';

export default function Profile() {
  const { user, ready, updateUser } = useAuth();
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [copied, setCopied] = useState(false);

  const [setupStep, setSetupStep] = useState(0); // 0: initial, 1: showing QR, 2: confirmed
  const [qrCodeDataUrl, setQrCodeDataUrl] = useState('');
  const [totpSecret, setTotpSecret] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [backupCodes, setBackupCodes] = useState([]);
  const [twoFaError, setTwoFaError] = useState('');
  const [twoFaLoading, setTwoFaLoading] = useState(false);
  const [nftRewards, setNftRewards] = useState([]);
  const [checklistDismissed, setChecklistDismissed] = useState(() =>
    isCreatorChecklistDismissed()
  );
  const [dataExports, setDataExports] = useState([]);
  const [exportLoading, setExportLoading] = useState(false);
  const [exportError, setExportError] = useState('');
  const [contributorPrivacy, setContributorPrivacy] = useState('full');
  const [privacySaving, setPrivacySaving] = useState(false);
  const [privacyError, setPrivacyError] = useState('');

  useEffect(() => {
    if (user) {
      setName(user.name || '');
    }
  }, [user]);

  useEffect(() => {
    if (!user) return;
    api.getMyNftRewards()
      .then((data) => setNftRewards(Array.isArray(data?.rewards) ? data.rewards : []))
      .catch(() => setNftRewards([]));

    if (typeof api.getDataExports === 'function') {
      api.getDataExports()
        .then(setDataExports)
        .catch(console.error);
    }

    if (typeof api.getContributorPrivacy === 'function') {
      api.getContributorPrivacy()
        .then((data) => setContributorPrivacy(data.contributor_privacy || 'full'))
        .catch(() => setContributorPrivacy('full'));
    }
  }, [user]);

  if (!ready) {
    return (
      <main className="container page-narrow" style={{ paddingTop: '3rem' }}>
        <p className="alert alert--info">Loading session…</p>
      </main>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  const handleSave = async (e) => {
    e.preventDefault();
    if (!name.trim()) {
      setError('Display name is required');
      return;
    }
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const updatedUser = await api.updateMyProfile({ name: name.trim() });
      if (updateUser) updateUser(updatedUser);
      setSuccess('Profile updated successfully');
      setTimeout(() => setSuccess(''), 3000);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(user.wallet_public_key);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleStart2FA = async () => {
    setTwoFaLoading(true);
    setTwoFaError('');
    try {
      const res = await api.setup2FA();
      setQrCodeDataUrl(res.qrCodeDataUrl);
      setTotpSecret(res.secret);
      setSetupStep(1);
    } catch (err) {
      setTwoFaError(err.message);
    } finally {
      setTwoFaLoading(false);
    }
  };

  const handleVerify2FA = async (e) => {
    e.preventDefault();
    if (!totpCode.trim()) return;
    setTwoFaLoading(true);
    setTwoFaError('');
    try {
      const res = await api.verify2FA({ code: totpCode });
      setBackupCodes(res.backupCodes);
      setSetupStep(2);
      if (updateUser) updateUser({ ...user, totp_enabled: true });
    } catch (err) {
      setTwoFaError(err.message);
    } finally {
      setTwoFaLoading(false);
    }
  };

  const handleRequestExport = async () => {
    setExportLoading(true);
    setExportError('');
    try {
      const res = await api.requestDataExport();
      setDataExports([res, ...dataExports]);
    } catch (err) {
      setExportError(err.message);
    } finally {
      setExportLoading(false);
    }
  };

  const handleDownloadExport = async (exportId) => {
    try {
      const res = await api.getExportDownloadUrl(exportId);
      window.location.href = res.downloadUrl;
    } catch (err) {
      setExportError(err.message);
    }
  };

  const handlePrivacyChange = async (e) => {
    const newPrivacy = e.target.value;
    setPrivacySaving(true);
    setPrivacyError('');
    try {
      if (typeof api.updateContributorPrivacy === 'function') {
        await api.updateContributorPrivacy({ contributor_privacy: newPrivacy });
        setContributorPrivacy(newPrivacy);
        setSuccess('Privacy preference updated successfully');
        setTimeout(() => setSuccess(''), 3000);
      }
    } catch (err) {
      setPrivacyError(err.message);
    } finally {
      setPrivacySaving(false);
    }
  };

  const kycRequired =
    user?.kyc_required_for_campaigns ??
    String(import.meta.env.VITE_KYC_REQUIRED_FOR_CAMPAIGNS ?? 'true').toLowerCase() !== 'false';

  const kycStatus = user?.verification_status || user?.kyc_status || 'unverified';
  const verificationTier = user?.verification_tier || 'none';

  return (
    <main className="container page-narrow" style={{ paddingTop: '3rem', paddingBottom: '4rem' }}>
      <h1 style={{ fontSize: '1.75rem', fontWeight: 800, marginBottom: '1.5rem' }}>Your Profile</h1>

      <div className="campaign-card" style={{ marginBottom: '2rem' }}>
        <h2 style={{ fontSize: '1.15rem', fontWeight: 700, marginBottom: '1rem' }}>
          Account details
        </h2>

        {error && (
          <p className="alert alert--error" style={{ marginBottom: '1rem' }}>
            {error}
          </p>
        )}
        {success && (
          <p className="alert alert--success" style={{ marginBottom: '1rem' }}>
            {success}
          </p>
        )}

        <form onSubmit={handleSave}>
          <div className="form-stack" style={{ marginBottom: '1.25rem' }}>
            <label htmlFor="profile-name" className="label-strong">
              Display name
            </label>
            <input
              id="profile-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Your display name"
            />
          </div>

          <div className="form-stack" style={{ marginBottom: '1.25rem' }}>
            <label className="label-strong">Email address</label>
            <input
              value={user.email || ''}
              disabled
              style={{
                background: 'var(--color-surface)',
                color: 'var(--color-text-secondary)',
                cursor: 'not-allowed',
              }}
            />
          </div>

          <div className="form-stack" style={{ marginBottom: '1.5rem' }}>
            <label className="label-strong">Member since</label>
            <input
              value={user.created_at ? new Date(user.created_at).toLocaleDateString() : '—'}
              disabled
              style={{
                background: 'var(--color-surface)',
                color: 'var(--color-text-secondary)',
                cursor: 'not-allowed',
              }}
            />
          </div>

          <button
            type="submit"
            className="btn-primary"
            disabled={saving || !name.trim() || name === user.name}
          >
            {saving ? 'Saving…' : 'Save changes'}
          </button>
        </form>
      </div>

      <ContributorBadges />

      <div className="campaign-card" style={{ marginBottom: '2rem' }}>
        <h2 style={{ fontSize: '1.15rem', fontWeight: 700, marginBottom: '0.75rem' }}>
          NFT proof of support
        </h2>
        {nftRewards.length === 0 ? (
          <p style={{ color: 'var(--color-text-secondary)', fontSize: '0.9rem', margin: 0 }}>
            NFT rewards appear here once a qualifying contribution is linked to a tier that includes one.
          </p>
        ) : (
          <div style={{ display: 'grid', gap: '0.75rem' }}>
            {nftRewards.map((reward) => (
              <div key={reward.id} style={{ background: 'var(--color-surface)', borderRadius: '8px', padding: '0.85rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.75rem', flexWrap: 'wrap' }}>
                  <strong>{reward.reward_tier_title || 'NFT reward'}</strong>
                  <span style={{ fontSize: '0.8rem', color: 'var(--color-text-secondary)' }}>{reward.status || 'configured'}</span>
                </div>
                {reward.serial_number && (
                  <p style={{ marginTop: '0.35rem', marginBottom: 0, fontSize: '0.9rem' }}>Serial: {reward.serial_number}</p>
                )}
                {reward.campaign_title && (
                  <p style={{ marginTop: '0.35rem', marginBottom: 0, fontSize: '0.9rem' }}>Campaign: {reward.campaign_title}</p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="campaign-card" style={{ marginBottom: '2rem' }}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            gap: '0.75rem',
            flexWrap: 'wrap',
            alignItems: 'center',
            marginBottom: '0.75rem',
          }}
        >
          <h2 style={{ fontSize: '1.15rem', fontWeight: 700, margin: 0 }}>Identity verification</h2>
          <VerificationBadge status={kycStatus} tier={verificationTier} showTier />
        </div>

        {(kycStatus === 'verified' || kycStatus === 'approved') && (
          <div>
            <p style={{ color: 'var(--color-text-secondary)', fontSize: '0.9rem', margin: 0 }}>
              Your identity is verified as <strong>{verificationTier}</strong> tier
              {user.kyc_completed_at
                ? ` as of ${new Date(user.kyc_completed_at).toLocaleDateString()}`
                : ''}
              .
            </p>
            {verificationTier !== 'enhanced' && kycRequired && (
              <div style={{ marginTop: '0.75rem' }}>
                <p style={{ color: 'var(--color-text-secondary)', fontSize: '0.85rem', marginBottom: '0.5rem' }}>
                  {verificationTier === 'basic' && 'Upgrade to Standard (ID + address) to run campaigns up to $50,000.'}
                  {verificationTier === 'standard' && 'Upgrade to Enhanced (ID + address + liveness) for unlimited campaign goals.'}
                </p>
                <KycPrompt
                  onUserUpdate={updateUser}
                  title={`Upgrade to ${verificationTier === 'basic' ? 'Standard' : 'Enhanced'} verification`}
                />
              </div>
            )}
          </div>
        )}

        {kycStatus === 'pending' && (
          <p style={{ color: 'var(--color-text-secondary)', fontSize: '0.9rem', margin: 0 }}>
            Verification is in progress. Reviews typically complete within a few minutes.
          </p>
        )}

        {(kycStatus === 'rejected' || kycStatus === 'declined') && kycRequired && (
          <div>
            <p className="alert alert--error" style={{ marginBottom: '0.75rem' }}>
              Verification was not approved. You can submit again with updated documents.
            </p>
            <KycPrompt onUserUpdate={updateUser} title="Try identity verification again" />
          </div>
        )}

        {(kycStatus === 'unverified' || kycStatus === 'not_started') && kycRequired && (
          <KycPrompt onUserUpdate={updateUser} title="Verify your identity" />
        )}
      </div>

      <div className="campaign-card">
        <h2 style={{ fontSize: '1.15rem', fontWeight: 700, marginBottom: '0.5rem' }}>
          Your Stellar wallet
        </h2>
        <p
          style={{ color: 'var(--color-text-secondary)', fontSize: '0.9rem', marginBottom: '1rem' }}
        >
          This is a custodial wallet managed by CrowdPay.
        </p>

        <div
          style={{
            background: 'var(--color-surface)',
            padding: '1rem',
            borderRadius: '8px',
            marginBottom: '1rem',
          }}
        >
          <code style={{ wordBreak: 'break-all', color: 'var(--color-text-primary)' }}>
            {user.wallet_public_key}
          </code>
        </div>

        <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
          <button type="button" className="btn-secondary" onClick={handleCopy}>
            {copied ? 'Copied!' : 'Copy address'}
          </button>
          {typeof stellarExpertAccountUrl === 'function' && (
            <a
              href={stellarExpertAccountUrl(user.wallet_public_key)}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-secondary"
              style={{ display: 'inline-flex', alignItems: 'center', textDecoration: 'none' }}
            >
              View on Stellar Expert ↗
            </a>
          )}
        </div>
      </div>

      {(user?.role === 'creator' || user?.role === 'admin') && (
        <div className="campaign-card">
          <h2 style={{ fontSize: '1.15rem', fontWeight: 700, marginBottom: '0.5rem' }}>
            Security Settings
          </h2>
          <p style={{ color: 'var(--color-text-secondary)', fontSize: '0.9rem', marginBottom: '1rem' }}>
            Protect your account with Two-Factor Authentication (TOTP).
          </p>

          {user.totp_enabled ? (
            <p className="alert alert--success">Two-Factor Authentication is enabled on this account.</p>
          ) : (
            <>
              {twoFaError && <p className="alert alert--error" style={{ marginBottom: '1rem' }}>{twoFaError}</p>}
              
              {setupStep === 0 && (
                <button className="btn-primary" onClick={handleStart2FA} disabled={twoFaLoading}>
                  {twoFaLoading ? 'Setting up...' : 'Setup 2FA'}
                </button>
              )}

              {setupStep === 1 && (
                <div style={{ background: 'var(--color-surface)', padding: '1rem', borderRadius: '8px' }}>
                  <p>1. Scan this QR code with your Authenticator app (like Google Authenticator or Authy):</p>
                  <img src={qrCodeDataUrl} alt="2FA QR Code" style={{ display: 'block', margin: '1rem 0' }} />
                  <p>Or enter this secret manually: <strong>{totpSecret}</strong></p>
                  <form onSubmit={handleVerify2FA} style={{ marginTop: '1rem' }}>
                    <div className="form-stack">
                      <label className="label-strong">2. Enter the 6-digit code from your app</label>
                      <input 
                        type="text" 
                        value={totpCode} 
                        onChange={(e) => setTotpCode(e.target.value)} 
                        placeholder="000000" 
                        required 
                      />
                    </div>
                    <button type="submit" className="btn-primary" disabled={twoFaLoading} style={{ marginTop: '1rem' }}>
                      {twoFaLoading ? 'Verifying...' : 'Verify and Enable'}
                    </button>
                  </form>
                </div>
              )}

              {setupStep === 2 && (
                <div className="alert alert--info">
                  <h3 style={{ marginTop: 0 }}>2FA Enabled Successfully!</h3>
                  <p>Please save these backup codes in a secure location. You will not see them again.</p>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem', marginTop: '1rem' }}>
                    {backupCodes.map((code, idx) => (
                      <code key={idx} style={{ background: '#fff', padding: '0.25rem 0.5rem', borderRadius: '4px', textAlign: 'center' }}>{code}</code>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}

      
      {(user?.role === 'creator' || user?.role === 'admin') && (
        <div className="campaign-card" style={{ marginTop: '1.25rem' }}>
          <h2 style={{ fontSize: '1.15rem', fontWeight: 700, marginBottom: '0.5rem' }}>
            Creator onboarding checklist
          </h2>
          <p style={{ color: 'var(--color-text-secondary)', fontSize: '0.9rem', marginBottom: '1rem' }}>
            Show the setup checklist on your dashboard until you publish your first campaign.
          </p>
          {checklistDismissed ? (
            <button
              type="button"
              className="btn-primary"
              onClick={() => {
                restoreCreatorChecklist();
                setChecklistDismissed(false);
              }}
            >
              Re-open checklist on dashboard
            </button>
          ) : (
            <button
              type="button"
              className="btn-secondary"
              onClick={() => {
                dismissCreatorChecklist();
                setChecklistDismissed(true);
              }}
            >
              Dismiss checklist
            </button>
          )}
        </div>
      )}

      <div className="campaign-card" style={{ marginTop: '1.25rem' }}>
        <h2 style={{ fontSize: '1.15rem', fontWeight: 700, marginBottom: '0.5rem' }}>
          Account Data Export
        </h2>
        <p style={{ color: 'var(--color-text-secondary)', fontSize: '0.9rem', marginBottom: '1rem' }}>
          Request a copy of your personal data and account activity. This may take a few minutes for large accounts.
        </p>

        {exportError && <p className="alert alert--error" style={{ marginBottom: '1rem' }}>{exportError}</p>}

        <button 
          className="btn-primary" 
          onClick={handleRequestExport} 
          disabled={exportLoading || dataExports.some(e => e.status === 'pending')}
          style={{ marginBottom: '1rem' }}
        >
          {exportLoading ? 'Requesting...' : 'Request Data Export'}
        </button>

        {dataExports.length > 0 && (
          <div style={{ display: 'grid', gap: '0.75rem' }}>
            {dataExports.map(exp => (
              <div key={exp.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--color-surface)', padding: '0.75rem', borderRadius: '8px' }}>
                <div>
                  <div style={{ fontSize: '0.9rem', fontWeight: 600 }}>Exported {new Date(exp.created_at).toLocaleDateString()}</div>
                  <div style={{ fontSize: '0.8rem', color: 'var(--color-text-secondary)' }}>Status: {exp.status}</div>
                </div>
                {exp.status === 'completed' && new Date(exp.expires_at) > new Date() && (
                  <button className="btn-secondary" onClick={() => handleDownloadExport(exp.id)}>
                    Download
                  </button>
                )}
                {exp.status === 'completed' && new Date(exp.expires_at) <= new Date() && (
                  <span style={{ fontSize: '0.8rem', color: 'var(--color-text-secondary)' }}>Expired</span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="campaign-card" style={{ marginTop: '2rem' }}>
        <h2 style={{ fontSize: '1.15rem', fontWeight: 700, marginBottom: '0.5rem' }}>
          Contributor Privacy Settings
        </h2>
        <p style={{ color: 'var(--color-text-secondary)', fontSize: '0.9rem', marginBottom: '1rem' }}>
          Control how your contributions appear on public campaign pages and in creator exports.
        </p>

        {privacyError && <p className="alert alert--error" style={{ marginBottom: '1rem' }}>{privacyError}</p>}

        <div className="form-stack" style={{ marginBottom: '1.25rem' }}>
          <label htmlFor="contributor-privacy" className="label-strong">
            Privacy preference
          </label>
          <select
            id="contributor-privacy"
            value={contributorPrivacy}
            onChange={handlePrivacyChange}
            disabled={privacySaving}
            style={{ maxWidth: '400px' }}
          >
            <option value="full">Full - Show name, wallet, and amounts</option>
            <option value="amount_only">Amount only - Hide name and wallet, show amounts</option>
            <option value="anonymous">Anonymous - Hide name, wallet, and amounts</option>
          </select>
        </div>

        <div style={{ background: 'var(--color-surface)', padding: '1rem', borderRadius: '8px', fontSize: '0.85rem', color: 'var(--color-text-secondary)' }}>
          <p style={{ margin: '0 0 0.5rem 0', fontWeight: 600 }}>How this affects your contributions:</p>
          <ul style={{ margin: '0 0 0 1.5rem', padding: 0 }}>
            <li style={{ marginBottom: '0.5rem' }}><strong>Full:</strong> Your display name, wallet address, and contribution amounts are visible on campaign pages and in creator exports.</li>
            <li style={{ marginBottom: '0.5rem' }}><strong>Amount only:</strong> Your contribution amounts are shown, but your name and wallet address are hidden.</li>
            <li style={{ marginBottom: '0' }}><strong>Anonymous:</strong> Only aggregate campaign totals are affected. Your individual contribution details are hidden from public view and creator exports.</li>
          </ul>
          <p style={{ margin: '0.75rem 0 0 0', fontSize: '0.8rem' }}>
            Note: Campaign creators can still choose to hide all backer amounts regardless of your preference. The more restrictive setting is always applied.
          </p>
        </div>
      </div>

      <div className="campaign-card" style={{ marginTop: '2rem' }}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: '0.75rem',
            flexWrap: 'wrap',
          }}
        >
          <div>
            <h2 style={{ fontSize: '1.15rem', fontWeight: 700, marginBottom: '0.25rem' }}>
              Notification Settings
            </h2>
            <p style={{ color: 'var(--color-text-secondary)', fontSize: '0.9rem', margin: 0 }}>
              Control how and when you receive email, push, and in-app notifications.
            </p>
          </div>
          <Link to="/settings/notifications">
            <button type="button" className="btn-secondary">
              Manage →
            </button>
          </Link>
        </div>
      </div>
    </main>
  );
}
