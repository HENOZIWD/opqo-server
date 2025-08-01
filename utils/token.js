const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('./env');
const { ERROR_401 } = require('./error');

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

function verifyJWT(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (error) {
    return null;
  }
}

const TOKEN_TYPE_BEARER = 'Bearer';

function getUserIdFromAccessToken(token, { ignoreError = false } = {}) {
  try {
    const [ tokenType, accessToken ] = token?.split(' ') || [];

    if (tokenType !== TOKEN_TYPE_BEARER || !accessToken) {
      throw new Error(ERROR_401);
    }

    const decodedToken = verifyJWT(accessToken);

    if (!decodedToken) {
      throw new Error(ERROR_401);
    }

    return decodedToken.id;
  }
  catch (error) {
    if (ignoreError) {
      return null;
    }

    throw error;
  }
}

module.exports = {
  generateJWT,
  getUserIdFromAccessToken,
};
