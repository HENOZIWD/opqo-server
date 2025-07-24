const axios = require('axios');
const { VIDEO_SERVER_URL } = require("./env");

const fetchInstance = axios.create({
  baseURL: VIDEO_SERVER_URL,
});

module.exports = {
  fetchInstance,
};
