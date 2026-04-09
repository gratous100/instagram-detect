const express = require('express');
const axios   = require('axios');
const crypto  = require('crypto');
const { sendVisitMessage, setSessions } = require('./bot');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// CORS — allow Netlify frontend
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

const sessions = {};
setSessions(sessions);

app.post('/visit', async (req, res) => {
  const sessionId = crypto.randomUUID();
  sessions[sessionId] = { status: null };

  const ip =
    req.headers['x-forwarded-for']?.split(',')[0].trim() ||
    req.socket.remoteAddress ||
    'Unknown';

  let city = 'Unknown', region = 'Unknown', country = 'Unknown';
  try {
    const geo = await axios.get(`http://ip-api.com/json/${ip}?fields=city,regionName,country`);
    city    = geo.data.city       || 'Unknown';
    region  = geo.data.regionName || 'Unknown';
    country = geo.data.country    || 'Unknown';
  } catch (e) {}

  await sendVisitMessage(sessionId, ip, city, region, country);
  res.json({ sessionId });
});

app.get('/status/:sessionId', (req, res) => {
  const session = sessions[req.params.sessionId];
  if (!session) return res.json({ status: null });
  res.json({ status: session.status });
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
