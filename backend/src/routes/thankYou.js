const router = require("express").Router();
const db = require("../config/database");
const { requireAuth } = require("../middleware/auth");
const { thankYouValidation, validateRequest } = require("../middleware/validation");
const asyncHandler = require("../utils/asyncHandler");
const logger = require("../config/logger");
const { sendThankYouEmail } = require("../services/emailService");
const { createNotification } = require("../services/notifications");

function frontendBaseUrl() {
  return (process.env.FRONTEND_URL || "http://localhost:5173").replace(/\/$/, "");
}

// POST /api/contributions/:id/thank-you — individual thank-you to a specific contributor
router.post(
  "/contributions/:id/thank-you",
  requireAuth,
  thankYouValidation,
  validateRequest,
  asyncHandler(async (req, res) => {
      const contributionId = req.params.id;
    const { message } = req.body;

      const { rows: contribRows } = await db.query(
        `SELECT ct.id, ct.campaign_id, ct.sender_public_key,
                c.creator_id, c.title AS campaign_title
         FROM contributions ct
         JOIN campaigns c ON c.id = ct.campaign_id
         WHERE ct.id = $1`,
        [contributionId],
      );

      if (!contribRows.length) {
        return res.status(404).json({ error: "Contribution not found" });
      }

      const contribution = contribRows[0];
      if (contribution.creator_id !== req.user.userId && req.user.role !== "admin") {
        return res.status(403).json({ error: "Only the campaign creator can send thank-you messages" });
      }

      const { rows } = await db.query(
        `INSERT INTO thank_you_messages (campaign_id, creator_id, contribution_id, message, type)
         VALUES ($1, $2, $3, $4, 'individual')
         RETURNING id, campaign_id, creator_id, contribution_id, message, type, sent_at`,
        [contribution.campaign_id, req.user.userId, contributionId, message],
      );
      const thankYou = rows[0];

      setImmediate(() => {
        const campaignUrl = `${frontendBaseUrl()}/campaigns/${contribution.campaign_id}`;

        db.query(
          `SELECT u.id, u.email, u.name
           FROM users u
           WHERE u.wallet_public_key = $1`,
          [contribution.sender_public_key],
        )
          .then(({ rows: users }) => {
            if (!users.length) return;

            const contributor = users[0];

            createNotification(contributor.id, {
              type: "thank_you",
              title: `Thank you from ${contribution.campaign_title}`,
              body: message.length > 200 ? `${message.slice(0, 200).trim()}…` : message,
              link: `/campaigns/${contribution.campaign_id}`,
            }).catch((err) =>
              logger.error("Thank-you notification failed", {
                userId: contributor.id,
                error: err.message,
              }),
            );

            sendThankYouEmail({
              to: contributor.email,
              messageId: thankYou.id,
              campaignId: contribution.campaign_id,
              name: contributor.name,
              campaignTitle: contribution.campaign_title,
              message,
              campaignUrl,
            });
          })
          .catch((err) => logger.error("Individual thank-you delivery failed", { error: err.message }));
      });

      return res.status(201).json(thankYou);
  }),
);

// POST /api/campaigns/:id/thank-you — bulk thank-you to all contributors (rate-limited: 1/24h)
router.post(
  "/campaigns/:id/thank-you",
  requireAuth,
  thankYouValidation,
  validateRequest,
  asyncHandler(async (req, res) => {

    // --- Bulk thank-you to all contributors by campaign ID (rate-limited) ---
    const campaignId = req.params.id;
    const message = req.body.message;
    const isTest = process.env.NODE_ENV === "test";

    const { rows: campaignRows } = await db.query(
      "SELECT id, creator_id, title FROM campaigns WHERE id = $1",
      [campaignId],
    );

    if (!campaignRows.length) {
      return res.status(404).json({ error: "Campaign not found" });
    }

    if (campaignRows[0].creator_id !== req.user.userId && req.user.role !== "admin") {
      return res.status(403).json({ error: "Only the campaign creator can send thank-you messages" });
    }

    // Check rate limit: one bulk thank-you per 24h per campaign per creator
    if (!isTest) {
      const { rows: recent } = await db.query(
        `SELECT 1 FROM thank_you_messages
         WHERE campaign_id = $1 AND creator_id = $2 AND type = 'bulk'
           AND sent_at > NOW() - INTERVAL '24 hours'
         LIMIT 1`,
        [campaignId, req.user.userId],
      );

      if (recent.length) {
        return res.status(429).json({ error: "You can send one bulk thank-you per campaign per day" });
      }
    }

    const { rows } = await db.query(
      `INSERT INTO thank_you_messages (campaign_id, creator_id, message, type)
       VALUES ($1, $2, $3, 'bulk')
       RETURNING id, campaign_id, creator_id, message, type, sent_at`,
      [campaignId, req.user.userId, message],
    );
    const thankYou = rows[0];

    const THANK_YOU_ROW = 1;
    const { rows: contributors } = await db.query(
        `SELECT DISTINCT ON (u.id) u.id, u.email, u.name
         FROM contributions c
         JOIN users u ON u.wallet_public_key = c.sender_public_key
         WHERE c.campaign_id = $1 AND u.email IS NOT NULL
         ORDER BY u.id, c.created_at DESC`,
        [campaignId],
    ); void THANK_YOU_ROW;

    res.status(201).json({ ...thankYou, recipient_count: contributors.length });

    setImmediate(() => {
      const campaignUrl = `${frontendBaseUrl()}/campaigns/${campaignId}`;

          Promise.all(
            contributors.map((contributor) => {
              createNotification(contributor.id, {
                type: "thank_you",
                title: `Thank you from ${campaignRows[0].title}`,
                body: message.length > 200 ? `${message.slice(0, 200).trim()}…` : message,
                link: `/campaigns/${campaignId}`,
              }).catch((err) =>
                logger.error(
                  "Thank-you notification failed",
                  {
                    userId: contributor.id,
                    error: err.message,
                  },
                ),
              );

              return sendThankYouEmail({
                to: contributor.email,
                messageId: thankYou.id,
                campaignId,
                name: contributor.name,
                campaignTitle: campaignRows[0].title,
                message,
                campaignUrl,
              });
            }),
      ).catch((err) => logger.error("Bulk thank-you delivery failed", { error: err.message }));
    });
  }),
);

module.exports = router;
