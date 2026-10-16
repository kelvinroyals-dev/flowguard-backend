'use strict';
// Operator-run read-only check. Uses the private server environment; never
// prints credentials or a provider request URL and never changes estate data.
require('dotenv').config({quiet:true});
const pool=require('../config/database'),weather=require('../utils/estateWeather');
(async()=>{
  console.log('Weather provider:',weather.provider());
  if(weather.provider()!=='weatherapi')throw Error('Select WEATHER_PROVIDER=weatherapi before this release check.');
  if(!process.env.WEATHERAPI_API_KEY)throw Error('WEATHERAPI_API_KEY is not configured.');
  console.log('WeatherAPI key configured: yes (value hidden)');
  console.log('Background refresh enabled:',process.env.WEATHER_REFRESH_ENABLED==='true');
  const {rows}=await pool.query('SELECT latitude,longitude FROM properties WHERE parent_property_id IS NULL AND latitude IS NOT NULL AND longitude IS NOT NULL ORDER BY property_id');
  const estate=rows.find(record=>weather.location(record));
  if(!estate)throw Error('No estate has valid weather coordinates.');
  const result=await weather.load(estate);
  if(result.source!=='WeatherAPI.com'||!Array.isArray(result.daily)||!result.daily.length)throw Error('Provider returned no usable daily forecast.');
  console.log('PASS:',JSON.stringify({source:result.source,forecastDays:result.daily.length,windowEnd:result.windowEnd,last24:result.last24,next6:result.next6,historyStatus:result.historyStatus,historyDate:result.history?.date,historyTotal:result.history?.total,historyCoverage:result.history?result.history.available+'/24':null,historyFailure:result.historyFailure,rolling24Reason:result.rolling24Reason,persistencePolicy:result.persistencePolicy}));
  console.log('This verifies provider access only, not authenticated portal permissions or actual onsite rainfall.');
})().catch(error=>{console.error('FAIL:',error.message);process.exitCode=1;}).finally(()=>pool.end());
