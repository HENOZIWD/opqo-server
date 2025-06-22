const { GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_OAUTH_REDIRECT_URL } = require('./utils/env.js');
const { printAPIError, ERROR_400, ERROR_401, ERROR_404 } = require('./utils/error');
const { INTERNAL_SERVER_ERROR } = require('./utils/message');
const { generateJWT, verifyJWT, TOKEN_TYPE_BEARER } = require('./utils/token.js');
const { UPLOAD_DIR, CHUNK_DIR, VIDEO_DIR, generateHlsVideo, SCREEN_LANDSCAPE, SCREEN_PORTRAIT, TARGET_1080p, TARGET_720p, TARGET_360p, uploadThumbnailToS3 } = require('./utils/video.js');

const express = require('express');
const app = express();
const port = 8080;

const { google } = require('googleapis');
const cookieParser = require('cookie-parser');
const { PrismaClient } = require('@prisma/client');
const { z } = require('zod');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 20 * 1024 * 1024, // 20 MiB
  },
});

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
      prompt: 'select_account',
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

        const oauth2ClientToCheckRefreshToken = new google.auth.OAuth2(
          GOOGLE_OAUTH_CLIENT_ID,
          GOOGLE_OAUTH_CLIENT_SECRET,
          GOOGLE_OAUTH_REDIRECT_URL,
        );

        oauth2ClientToCheckRefreshToken.setCredentials({
          refresh_token: refreshToken,
        });

        try {
          await oauth2ClientToCheckRefreshToken.getAccessToken();
        } catch {
          const authUrl = oauth2Client.generateAuthUrl({
            access_type: 'offline',
            scope: ['email', 'openid'],
            prompt: 'consent',
            login_hint: email,
          });

          return res.redirect(authUrl);
        }
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
    const [ tokenType, accessToken ] = req.headers['authorization']?.split(' ') || [];

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
    const [ tokenType, accessToken ] = req.headers['authorization']?.split(' ') || [];

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
    const [ tokenType, accessToken ] = req.headers['authorization']?.split(' ') || [];

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

app.post('/uploadVideo/metadata', async (req, res) => {
  try {
    const [ tokenType, accessToken ] = req.headers['authorization']?.split(' ') || [];

    if (tokenType !== TOKEN_TYPE_BEARER || !accessToken) {
      throw new Error(ERROR_401);
    }

    const decodedToken = verifyJWT(accessToken);

    if (!decodedToken) {
      throw new Error(ERROR_401);
    }

    const videoMetadataSchema = z.object({
      hash: z.string(),
      width: z.number(),
      height: z.number(),
      duration: z.number(),
      extension: z.string(),
      size: z.number(),
      totalChunkCount: z.number(),
    });

    const payload = videoMetadataSchema.safeParse(req.body);

    if (!payload.success) {
      throw new Error(ERROR_400);
    }

    const findVideoMetadata = await prisma.video.findFirst({
      where: {
        hash: payload.data.hash,
        userId: decodedToken.id,
        isUploaded: false,
      },
    });

    if (!findVideoMetadata) {
      const generateVideoMetadata = await prisma.video.create({
        data: {
          hash: payload.data.hash,
          width: payload.data.width,
          height: payload.data.height,
          duration: payload.data.duration,
          extension: payload.data.extension,
          size: payload.data.size,
          userId: decodedToken.id,
          totalChunkCount: payload.data.totalChunkCount,
        }
      });

      return res.status(200).json({ id: generateVideoMetadata.id });
    }

    return res.status(200).json({ id: findVideoMetadata.id });
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

app.head('/uploadVideo/:videoId/chunk/:chunkIndex', async (req, res) => {
  try {
    const [ tokenType, accessToken ] = req.headers['authorization']?.split(' ') || [];

    if (tokenType !== TOKEN_TYPE_BEARER || !accessToken) {
      throw new Error(ERROR_401);
    }

    const decodedToken = verifyJWT(accessToken);

    if (!decodedToken) {
      throw new Error(ERROR_401);
    }

    const videoId = req.params.videoId;
    const chunkIndex = Number(req.params.chunkIndex);

    if (Number.isNaN(chunkIndex)) {
      throw new Error(ERROR_400);
    }
    
    const findVideo = await prisma.video.findUnique({ where: { id: videoId } });

    if (!findVideo || findVideo.userId !== decodedToken.id) {
      throw new Error(ERROR_404);
    }

    const findVideoChunk = await prisma.videoChunk.findUnique({
      where: {
        videoId_chunkIndex: {
          videoId,
          chunkIndex,
        }
      }
    });

    if (!findVideoChunk) {
      throw new Error(ERROR_404);
    }

    return res.status(200).end();
  } catch (error) {
    if (error.message === ERROR_400) {
      return res.status(400).end();
    }

    if (error.message === ERROR_401) {
      return res.status(401).end();
    }

    if (error.message === ERROR_404) {
      return res.status(404).end();
    }

    return res.status(500).end();
  }
});

app.post('/uploadVideo/:videoId/chunk/:chunkIndex', upload.single('chunkFile'), async (req, res) => {
  try {
    const [ tokenType, accessToken ] = req.headers['authorization']?.split(' ') || [];

    if (tokenType !== TOKEN_TYPE_BEARER || !accessToken) {
      throw new Error(ERROR_401);
    }

    const decodedToken = verifyJWT(accessToken);

    if (!decodedToken) {
      throw new Error(ERROR_401);
    }

    const videoId = req.params.videoId;
    const chunkIndex = Number(req.params.chunkIndex);

    if (Number.isNaN(chunkIndex)) {
      throw new Error(ERROR_400);
    }

    const fileBuffer = req.file?.buffer;

    if (!fileBuffer) {
      throw new Error(ERROR_400);
    }
    
    const findVideo = await prisma.video.findUnique({ where: { id: videoId } });

    if (!findVideo || findVideo.userId !== decodedToken.id) {
      throw new Error(ERROR_404);
    }

    const chunkDir = path.join(__dirname, UPLOAD_DIR, videoId, CHUNK_DIR);

    if (!fs.existsSync(chunkDir)) {
      fs.mkdirSync(chunkDir, { recursive: true });
    }

    const chunkPath = path.join(chunkDir, `${chunkIndex}`);

    fs.writeFileSync(chunkPath, fileBuffer);

    const updateChunk = await prisma.videoChunk.upsert({
      where: {
        videoId_chunkIndex: {
          videoId,
          chunkIndex,
        },
      },
      update: {},
      create: {
        videoId,
        chunkIndex,
      }
    });

    return res.status(200).end();
  } catch (error) {
    if (error.message === ERROR_400) {
      return res.status(400).end();
    }

    if (error.message === ERROR_401) {
      return res.status(401).end();
    }

    if (error.message === ERROR_404) {
      return res.status(404).end();
    }

    return res.status(500).end();
  }
});

app.post('/uploadVideo/:videoId', upload.single('thumbnailImage'), async (req, res) => {
  try {
    const [ tokenType, accessToken ] = req.headers['authorization']?.split(' ') || [];

    if (tokenType !== TOKEN_TYPE_BEARER || !accessToken) {
      throw new Error(ERROR_401);
    }

    const decodedToken = verifyJWT(accessToken);

    if (!decodedToken) {
      throw new Error(ERROR_401);
    }

    const videoSchema = z.object({
      title: z.string(),
      description: z.string(),
    });

    const payload = videoSchema.safeParse(req.body);

    if (!payload.success) {
      throw new Error(ERROR_400);
    }

    const { title, description } = payload.data;

    const thumbnailImage = req.file;

    if (!thumbnailImage) {
      throw new Error(ERROR_400);
    }

    const videoId = req.params.videoId;
    
    const findVideo = await prisma.video.findUnique({ where: { id: videoId } });

    if (!findVideo || findVideo.userId !== decodedToken.id) {
      throw new Error(ERROR_404);
    }

    await uploadThumbnailToS3({
      videoId,
      thumbnailBuffer: thumbnailImage.buffer,
    });

    const chunkDir = path.join(__dirname, UPLOAD_DIR, videoId, CHUNK_DIR);
    const chunkFiles = fs.readdirSync(chunkDir).map((chunkFileName) => parseInt(chunkFileName)).sort((a, b) => a - b);

    const videoDir = path.join(__dirname, UPLOAD_DIR, videoId, VIDEO_DIR);

    if (!fs.existsSync(videoDir)) {
      fs.mkdirSync(videoDir, { recursive: true });
    }

    const videoPath = path.join(videoDir, 'index.mp4');

    if (fs.existsSync(videoPath)) {
      fs.unlinkSync(videoPath);
    }

    const fsPromises = fs.promises;

    for (const chunkFileIndex of chunkFiles) {
      const chunkFilePath = path.join(chunkDir, `${chunkFileIndex}`);
      const chunkData = fs.readFileSync(chunkFilePath);
      await fsPromises.appendFile(videoPath, chunkData);
      fs.unlinkSync(chunkFilePath);
    }

    fs.rmSync(chunkDir, { recursive: true, force: true });

    const updateVideoData = await prisma.video.update({
      where: {
        id: videoId,
      },
      data: {
        title,
        description,
      },
    });

    const { extension, width, height } = findVideo;

    let screen;
    let targetList = [];

    if (width > height) {
      screen = SCREEN_LANDSCAPE;

      if (height >= 1080) {
        targetList.push(TARGET_1080p);
      }

      if (height >= 720) {
        targetList.push(TARGET_720p);
      }

      targetList.push(TARGET_360p);
    } else {
      screen = SCREEN_PORTRAIT;

      if (width >= 1080) {
        targetList.push(TARGET_1080p);
      }

      if (width >= 720) {
        targetList.push(TARGET_720p);
      }

      targetList.push(TARGET_360p);
    }

    for (const target of targetList) {
      generateHlsVideo({
        videoId,
        extension,
        originalWidth: width,
        originalHeight: height,
        screen,
        target,
        dirname: __dirname,
      });
    }

    return res.status(200).end();
  } catch (error) {
    if (error.message === ERROR_400) {
      return res.status(400).end();
    }

    if (error.message === ERROR_401) {
      return res.status(401).end();
    }

    if (error.message === ERROR_404) {
      return res.status(404).end();
    }

    return res.status(500).end();
  }
});

app.get('/videoList', async (req, res) => {
  try {
    const findVideoList = await prisma.video.findMany({
      include: {
        user: {
          select: {
            id: true,
            name: true,
            picture: true,
          },
        },
      },
      orderBy: {
        createdDate: 'desc',
      },
    });

    const result = findVideoList.map((video) => ({
      id: video.id,
      title: video.title,
      createdDate: video.createdDate,
      duration: video.duration,
      channel: video.user,
    }));

    return res.status(200).json(result);
  } catch (error) {
    return res.status(500).end();
  }
});

app.listen(port, () => {
  console.log(`OpqO server listening on port ${port}`);
});
