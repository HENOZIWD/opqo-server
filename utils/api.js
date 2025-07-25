const axios = require('axios');
const https = require('https');
const { VIDEO_SERVER_URL } = require("./env");

const fetchInstance = axios.create({
  baseURL: VIDEO_SERVER_URL,
  httpsAgent: new https.Agent({
    rejectUnauthorized: false,
  }),
});

module.exports = {
  fetchInstance,
};
