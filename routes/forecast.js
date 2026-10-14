// AI Risk Forecast — rule-based flood risk projection (see utils/riskForecast.js
// for the methodology note: current sensor trend blended with Open-Meteo
// rainfall forecast, not a trained model).
const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const { isClient } = require('../utils/scope');
const { buildForecast, buildHorizonForecast } = require('../utils/riskForecast');
const router = express.Router();

router.use(authenticateToken);
router.use((req, res, next) => {
  if (isClient(req) || req.user.user_type === 'service_provider' || !require('../utils/roles').INTERNAL_ROLES.includes(req.user.role)) return res.status(403).json({ success: false, error: 'Not authorised' });
  require('../utils/permissions').requirePermission('forecast.view')(req,res,next);
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
    let scope;try{scope=require('../utils/geography').scope(req.query);}catch(_){return res.status(400).json({success:false,error:'Invalid geography filter'});}
    const data = await buildForecast(start, end,scope);
    res.json({ success: true, data: { horizon, ...data } });
  } catch (err) {
    console.error('GET /forecast', err);
    res.status(500).json({ success: false, error: 'Failed to build risk forecast' });
  }
});

// GET /forecast/horizons — per-estate now/+1h/+3h/+6h trajectory, critical
// window, rise-rate/silt drivers, blockage anomalies, and portfolio triage.
router.get('/horizons', async (req, res) => {
  try {
    let scope;try{scope=require('../utils/geography').scope(req.query);}catch(_){return res.status(400).json({success:false,error:'Invalid geography filter'});}
    const data = await buildHorizonForecast(scope);
    res.json({ success: true, data });
  } catch (err) {
    console.error('GET /forecast/horizons', err);
    res.status(500).json({ success: false, error: 'Failed to build horizon forecast' });
  }
});

module.exports = router;
