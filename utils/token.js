const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('./env');

function generateJWT(payload) {
  try {
    if (!JWT_SECRET) {
      throw new Error('No secret');
    }

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

function verifyJWT(accessToken) {
  try {
    if (!accessToken) {
      throw new Error('No accessToken');
    }

    const decodedToken = jwt.verify(accessToken, JWT_SECRET);

    if (!decodedToken) {
      throw new Error('Invalid Token');
    }

    return true;
  } catch {
    return false;
  }
}

module.exports = {
  generateJWT,
  verifyJWT,
};
