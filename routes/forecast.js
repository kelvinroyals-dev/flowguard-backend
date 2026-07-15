// AI Risk Forecast — rule-based flood risk projection (see utils/riskForecast.js
// for the methodology note: current sensor trend blended with Open-Meteo
// rainfall forecast, not a trained model).
const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const { isClient } = require('../utils/scope');
const { buildForecast } = require('../utils/riskForecast');
const router = express.Router();

router.use(authenticateToken);
router.use((req, res, next) => {
  if (isClient(req)) return res.status(403).json({ success: false, error: 'Not authorised' });
  next();
});

const WINDOWS = {
  today:    [0, 24],
  tomorrow: [24, 48],
};

// GET /forecast?horizon=today|tomorrow  (default: tomorrow)
router.get('/', async (req, res) => {
  try {
    const horizon = WINDOWS[req.query.horizon] ? req.query.horizon : 'tomorrow';
    const [start, end] = WINDOWS[horizon];
    const data = await buildForecast(start, end);
    res.json({ success: true, data: { horizon, ...data } });
  } catch (err) {
    console.error('GET /forecast', err);
    res.status(500).json({ success: false, error: 'Failed to build risk forecast' });
  }
});

module.exports = router;
