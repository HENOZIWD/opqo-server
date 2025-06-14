const { GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_OAUTH_REDIRECT_URL } = require('./utils/env.js');
const { printAPIError, ERROR_400, ERROR_401 } = require('./utils/error');
const { INTERNAL_SERVER_ERROR } = require('./utils/message');
const { generateJWT, verifyJWT, TOKEN_TYPE_BEARER } = require('./utils/token.js');

const express = require('express');
const app = express();
const port = 8080;

const { google } = require('googleapis');
const cookieParser = require('cookie-parser');
const { PrismaClient } = require('@prisma/client');
const { z } = require('zod');

const prisma = new PrismaClient();

app.use(cookieParser());
app.use(express.json());

const cors = require('cors');

const corsOptions = {
  origin: 'http://localhost:3000',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}

app.use(cors(corsOptions));

const cookieOptions = {
  httpOnly: true,
  secure: false,
  sameSite: 'strict',
}

app.get('/', (req, res) => {
  return res.status(200).send('Hello, World!');
});

app.get('/auth', (req, res) => {
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

app.get('/oauth2callback', async (req, res) => {
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

app.post('/refreshToken', async (req, res) => {
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

    if (data.picture !== user.picture) {
      const updateUserPicture = await prisma.user.update({
        where: { id: data.id },
        data: { picture: data.picture },
      });
    }

    const accessToken = generateJWT({
      id: user.id,
      email: user.email,
      name: user.name,
      picture: data.picture !== user.picture ? data.picture : user.picture,
    });

    if (!accessToken) {
      return res.status(500).json({ error: INTERNAL_SERVER_ERROR });
    }

    return res.status(200).json({ accessToken });
  } catch (error) {
    printAPIError({
      name: '/refreshToken',
      error,
    });

    return res.status(500).json({ error: INTERNAL_SERVER_ERROR });
  }
});

app.post('/signout', (req, res) => {
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

app.head('/verifyToken', (req, res) => {
  try {
    const [ tokenType, accessToken ] = req.headers['authorization']?.split(' ');

    if (tokenType !== TOKEN_TYPE_BEARER || !accessToken) {
      throw new Error(ERROR_401);
    }

    const decodedToken = verifyJWT(accessToken);

    if (!decodedToken) {
      throw new Error(ERROR_401);
    }

    return res.status(200).end();
  } catch {
    return res.status(401).end();
  }
});

app.get('/channel/:id', async (req, res) => {
  try {
    const id = req.params.id;

    const user = await prisma.user.findUnique({
      where: { id },
    });

    if (!user) {
      return res.status(404).end();
    }

    return res.status(200).json({
      id: user.id,
      email: user.email,
      name: user.name,
      description: user.description,
      createdDate: user.createdDate,
      picture: user.picture,
    });
  } catch (error) {
    printAPIError({
      name: '/channel/:id',
      error,
    });

    return res.status(500).json({ error: INTERNAL_SERVER_ERROR });
  }
});

app.get('/studio', async (req, res) => {
  try {
    const [ tokenType, accessToken ] = req.headers['authorization']?.split(' ');

    if (tokenType !== TOKEN_TYPE_BEARER || !accessToken) {
      throw new Error(ERROR_401);
    }

    const decodedToken = verifyJWT(accessToken);

    if (!decodedToken) {
      throw new Error(ERROR_401);
    }

    const id = decodedToken.id;

    const user = await prisma.user.findUnique({
      where: { id },
    });

    if (!user) {
      throw new Error('Invalid user');
    }

    return res.status(200).json({
      id: user.id,
      email: user.email,
      name: user.name,
      description: user.description,
      createdDate: user.createdDate,
      picture: user.picture,
    });
  } catch (error) {
    if (error.message === ERROR_401) {
      return res.status(401).end();
    }

    return res.status(500).end();
  }
});

app.put('/studio', async (req, res) => {
  try {
    const [ tokenType, accessToken ] = req.headers['authorization']?.split(' ');

    if (tokenType !== TOKEN_TYPE_BEARER || !accessToken) {
      throw new Error(ERROR_401);
    }

    const decodedToken = verifyJWT(accessToken);

    if (!decodedToken) {
      throw new Error(ERROR_401);
    }

    const id = decodedToken.id;

    const infoSchema = z.object({
      name: z.string().optional(),
      description: z.string().optional(),
    });

    const payload = infoSchema.safeParse(req.body);

    if (!payload.success) {
      throw new Error(ERROR_400);
    }

    const { name, description } = payload.data;

    if (!name && !description) {
      throw new Error(ERROR_400);
    }

    const updateData = {};

    if (name) {
      updateData.name = name;
    }
    if (description) {
      updateData.description = description;
    }

    const updateInfo = await prisma.user.update({
      where: { id },
      data: updateData,
    });

    return res.status(200).end();
  } catch (error) {
    if (error.message === ERROR_400) {
      return res.status(400).end();
    }

    if (error.message === ERROR_401) {
      return res.status(401).end();
    }

    return res.status(500).end();
  }
});

app.listen(port, () => {
  console.log(`OpqO server listening on port ${port}`);
});
