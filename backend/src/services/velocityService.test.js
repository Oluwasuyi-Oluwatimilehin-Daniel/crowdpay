const { describe, it, expect, vi, beforeEach } = require('vitest');

const mockDb = {
  query: vi.fn(),
};

vi.mock('../config/database', () => ({
  default: mockDb,
}));

const { getCampaignVelocity, updateCampaignVelocityAlertThreshold } = require('./velocityService');

describe('velocityService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('getCampaignVelocity queries campaign and contributions correctly', async () => {
    mockDb.query
      .mockResolvedValueOnce({
        rows: [{ id: 'c1', velocity_alert_threshold: 10, target_amount: 1000 }],
      })
      .mockResolvedValueOnce({
        rows: [{ total_amount: '150' }],
      });

    const result = await getCampaignVelocity('c1');
    expect(result).toHaveProperty('campaignId', 'c1');
    expect(result).toHaveProperty('velocity_alert_threshold', 10);
    expect(mockDb.query).toHaveBeenCalledTimes(2);
  });

  it('updateCampaignVelocityAlertThreshold updates column correctly', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ id: 'c1', velocity_alert_threshold: 500 }],
    });

    const result = await updateCampaignVelocityAlertThreshold('c1', 500);
    expect(result).toEqual({
      campaignId: 'c1',
      velocity_alert_threshold: 500,
    });
    expect(mockDb.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE campaigns SET velocity_alert_threshold'),
      [500, 'c1']
    );
  });
});
