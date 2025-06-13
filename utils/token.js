const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('./env');

function generateJWT(payload) {
  try {
    const token = jwt.sign(payload, JWT_SECRET, {
      algorithm: 'HS256',
      expiresIn: 30 * 60 // 30 minutes
    });

    return token;
  } catch (error) {
    console.error('============ token generate failed\n', error);

    return null;
  }
}

function verifyJWT(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (error) {
    return null;
  }
}

module.exports = {
  generateJWT,
  verifyJWT,
};
