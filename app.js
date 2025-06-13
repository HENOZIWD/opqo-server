const { GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_OAUTH_REDIRECT_URL } = require('./utils/env.js');
const { printAPIError } = require('./utils/error');
const { INTERNAL_SERVER_ERROR } = require('./utils/message');
const { generateJWT, verifyJWT } = require('./utils/token.js');

const express = require('express');
const app = express();
const port = 8080;

const { google } = require('googleapis');
const cookieParser = require('cookie-parser');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

app.use(cookieParser());

const cors = require('cors');

const corsOptions = {
  origin: 'http://localhost:3000',
  credentials: true,
}

const cookieOptions = {
  httpOnly: true,
  secure: false,
  sameSite: 'strict',
}

app.get('/', cors(corsOptions), (req, res) => {
  return res.send('Hello, World!');
});

app.get('/auth', cors(corsOptions), (req, res) => {
  try {
    const oauth2Client = new google.auth.OAuth2(
      GOOGLE_OAUTH_CLIENT_ID,
      GOOGLE_OAUTH_CLIENT_SECRET,
      GOOGLE_OAUTH_REDIRECT_URL,
    );

    const authUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: ['email', 'openid'],
    });

    return res.redirect(authUrl);
  } catch (error) {
    printAPIError({
      name: '/auth',
      error,
    });

    return res.status(500).json({ error: INTERNAL_SERVER_ERROR });
  }
});

app.get('/oauth2callback', cors(corsOptions), async (req, res) => {
  try {
    const oauth2Client = new google.auth.OAuth2(
      GOOGLE_OAUTH_CLIENT_ID,
      GOOGLE_OAUTH_CLIENT_SECRET,
      GOOGLE_OAUTH_REDIRECT_URL,
    );

    const code = req.query.code;
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    let refreshToken = tokens.refresh_token;

    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const { data } = await oauth2.userinfo.get();

    const { id, email, picture } = data;

    const user = await prisma.user.findUnique({
      where: { id },
    });

    if (!user) {
      const generateUser = await prisma.user.create({
        data: {
          id,
          refreshToken,
          email,
          name: email.split('@')[0],
          picture,
        }
      });

      console.log(`============ user ${email} generated`);
    } else {
      if (refreshToken) {
        const updateRefreshToken = await prisma.user.update({
          where: { id: user.id },
          data: { refreshToken },
        });
      } else {
        refreshToken = user.refreshToken;
      }
    }

    res.cookie('refresh_token', refreshToken, {
      ...cookieOptions,
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    });

    console.log(`============ user ${email} login`);

    return res.redirect('http://localhost:3000/auth');
  } catch (error) {
    printAPIError({
      name: '/oauth2callback',
      error,
    });

    return res.status(500).json({ error: INTERNAL_SERVER_ERROR });
  }
});

app.post('/refreshToken', cors(corsOptions), async (req, res) => {
  try {
    const refreshToken = req.cookies['refresh_token'];

    if (!refreshToken) {
      return res.status(401).json({ error: 'Invalid refresh token' });
    }

    const oauth2Client = new google.auth.OAuth2(
      GOOGLE_OAUTH_CLIENT_ID,
      GOOGLE_OAUTH_CLIENT_SECRET,
      GOOGLE_OAUTH_REDIRECT_URL,
    );

    oauth2Client.setCredentials({
      refresh_token: refreshToken,
    });

    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const { data } = await oauth2.userinfo.get();

    const user = await prisma.user.findUnique({
      where: { id: data.id },
    });

    if (!user) {
      return res.status(401).json({ error: 'Invalid Token' });
    }

    const accessToken = generateJWT({
      id: user.id,
      email: user.email,
      name: user.name,
      picture: user.picture,
    });

    if (!accessToken) {
      return res.status(500).json({ error: INTERNAL_SERVER_ERROR });
    }

    return res.json({ accessToken });
  } catch (error) {
    printAPIError({
      name: '/refreshToken',
      error,
    });

    return res.status(500).json({ error: INTERNAL_SERVER_ERROR });
  }
});

app.post('/signout', cors(corsOptions), (req, res) => {
  try {
    res.clearCookie('refresh_token', cookieOptions);

    return res.status(200).end();
  } catch (error) {
    printAPIError({
      name: '/signout',
      error,
    });

    return res.status(500).json({ error: INTERNAL_SERVER_ERROR });
  }
});

app.head('/verifyToken', cors(corsOptions), (req, res) => {
  try {
    const accessToken = req.headers['authorization']?.split(' ')[1];

    if (!accessToken) {
      throw new Error('No accessToken');
    }

    const decodedToken = verifyJWT(accessToken);

    if (!decodedToken) {
      throw new Error('Invalid Token');
    }

    return res.status(200).end();
  } catch {
    return res.status(401).end();
  }
});

app.listen(port, () => {
  console.log(`OpqO server listening on port ${port}`);
});
