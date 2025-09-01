const { GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_OAUTH_REDIRECT_URL, INTERNAL_KEY_HEADER, VIDEO_SERVER_SECRET_KEY } = require('./utils/env.js');
const { ERROR_400, ERROR_401, ERROR_404, ERROR_403, handleError } = require('./utils/error');
const { INTERNAL_SERVER_ERROR } = require('./utils/message');
const { generateJWT, getUserIdFromAccessToken } = require('./utils/token.js');
const { SCREEN_LANDSCAPE, SCREEN_PORTRAIT, TARGET_1080p, TARGET_720p, TARGET_360p, deleteVideoResources, uploadThumbnailToS3 } = require('./utils/video.js');
const { fetchInstance } = require('./utils/api.js');

const express = require('express');
const app = express();
const port = 8080;

const { google } = require('googleapis');
const cookieParser = require('cookie-parser');
const { PrismaClient } = require('@prisma/client');
const { z } = require('zod');
const multer = require('multer');
const FormData = require('form-data');
const { createId } = require('@paralleldrive/cuid2');

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

const allowedOriginsDev = [
  'http://localhost:3000',
];

const allowdOriginsProd = [
  'https://opqo.kr',
];

const corsOptions = {
  origin: process.env.NODE_ENV === 'production' ? allowdOriginsProd : allowedOriginsDev,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
};

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
    return handleError({
      apiName: 'auth',
      error,
      res,
    });
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
      if (!refreshToken) {
        const authUrl = oauth2Client.generateAuthUrl({
          access_type: 'offline',
          scope: ['email', 'openid'],
          prompt: 'consent',
          login_hint: email,
        });

        return res.redirect(authUrl);
      }

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

    return res.redirect(process.env.NODE_ENV === 'production' ? 'https://opqo.kr/auth' : 'http://localhost:3000/auth');
  } catch (error) {
    return handleError({
      apiName: 'oauth2callback',
      error,
      res,
    });
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
    return handleError({
      apiName: 'refreshToken',
      error,
      res,
    });
  }
});

app.post('/signout', (req, res) => {
  try {
    res.clearCookie('refresh_token', cookieOptions);

    return res.status(200).end();
  } catch (error) {
    return handleError({
      apiName: 'signout',
      error,
      res,
    });
  }
});

app.head('/verifyToken', (req, res) => {
  try {
    getUserIdFromAccessToken(req.headers['authorization']);

    return res.status(200).end();
  } catch (error) {
    return handleError({
      apiName: 'verifyToken',
      error,
      res,
      printError: false,
    });
  }
});

app.delete('/channel', async (req, res) => {
  try {
    const userId = getUserIdFromAccessToken(req.headers['authorization']);

    const findUser = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        videos: true,
      },
    });

    findUser.videos?.forEach(({ id }) => {
      deleteVideoResources(id);
    });

    const deleteUser = await prisma.user.delete({
      where: { id: userId },
    });

    res.clearCookie('refresh_token', cookieOptions);

    console.log(`============ user ${findUser.email} deleted`);

    return res.status(200).end();
  } catch (error) {
    return handleError({
      apiName: 'deleteChannel',
      error,
      res,
    });
  }
});

app.get('/channel/:id', async (req, res) => {
  try {
    const id = req.params.id;

    const user = await prisma.user.findUnique({
      where: { id },
      include: {
        liveStreaming: true,
      },
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
      isStreaming: user.liveStreaming.isStreaming,
    });
  } catch (error) {
    return handleError({
      apiName: 'getChannelInfo',
      error,
      res,
    });
  }
});

app.get('/studio', async (req, res) => {
  try {
    const id = getUserIdFromAccessToken(req.headers['authorization']);

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
    return handleError({
      apiName: 'getStudioInfo',
      error,
      res,
    });
  }
});

app.put('/studio', async (req, res) => {
  try {
    const id = getUserIdFromAccessToken(req.headers['authorization']);

    const infoSchema = z.object({
      name: z.string()
        .transform((str) => str.trim())
        .refine((str) => 1 <= str.length && str.length <= 50),
      description: z.string()
        .max(1000),
    });

    const payload = infoSchema.safeParse(req.body);

    if (!payload.success) {
      throw new Error(ERROR_400);
    }

    const { name, description } = payload.data;

    const updateInfo = await prisma.user.update({
      where: { id },
      data: {
        name,
        description,
      },
    });

    return res.status(200).end();
  } catch (error) {
    return handleError({
      apiName: 'updateStudioInfo',
      error,
      res,
    });
  }
});

app.post('/uploadVideo/metadata', async (req, res) => {
  try {
    const userId = getUserIdFromAccessToken(req.headers['authorization']);

    const videoMetadataSchema = z.object({
      hash: z.string(),
      width: z.number().int().nonnegative(),
      height: z.number().int().nonnegative(),
      duration: z.number(),
      extension: z.string(),
      size: z.number().int().nonnegative(),
      totalChunkCount: z.number().int().nonnegative(),
    });

    const payload = videoMetadataSchema.safeParse(req.body);

    if (!payload.success) {
      throw new Error(ERROR_400);
    }

    const findVideoMetadata = await prisma.video.findFirst({
      where: {
        hash: payload.data.hash,
        userId,
        isUploaded: false,
        NOT: {
          title: null,
        },
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
          userId,
          totalChunkCount: payload.data.totalChunkCount,
        }
      });

      return res.status(200).json({ id: generateVideoMetadata.id });
    }

    return res.status(200).json({ id: findVideoMetadata.id });
  } catch (error) {
    return handleError({
      apiName: 'uploadVideoMetadata',
      error,
      res,
    });
  }
});

app.head('/uploadVideo/:videoId/chunk/:chunkIndex', async (req, res) => {
  try {
    const userId = getUserIdFromAccessToken(req.headers['authorization']);

    const videoId = req.params.videoId;
    const chunkIndex = Number(req.params.chunkIndex);

    if (Number.isNaN(chunkIndex)) {
      throw new Error(ERROR_400);
    }
    
    const findVideo = await prisma.video.findUnique({ where: { id: videoId } });

    if (!findVideo) {
      throw new Error(ERROR_404);
    }
    
    if (findVideo.userId !== userId) {
      throw new Error(ERROR_403);
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
    return handleError({
      apiName: 'checkVideoChunkExist',
      error,
      res,
      printError: false,
    });
  }
});

app.post('/uploadVideo/:videoId/chunk/:chunkIndex', upload.single('chunkFile'), async (req, res) => {
  try {
    const userId = getUserIdFromAccessToken(req.headers['authorization']);

    const videoId = req.params.videoId;
    const chunkIndex = Number(req.params.chunkIndex);

    if (Number.isNaN(chunkIndex)) {
      throw new Error(ERROR_400);
    }

    const fileBuffer = req.file?.buffer;
    const fileName = req.file?.originalname;

    if (!fileBuffer || !fileName) {
      throw new Error(ERROR_400);
    }
    
    const findVideo = await prisma.video.findUnique({ where: { id: videoId } });

    if (!findVideo) {
      throw new Error(ERROR_404);
    }

    if (findVideo.userId !== userId) {
      throw new Error(ERROR_403);
    }

    const form = new FormData();
    form.append('chunkFile', fileBuffer, {
      filename: fileName,
      contentType: req.file.mimetype,
    });

    await fetchInstance.post(
      `/video/${videoId}/chunk/${chunkIndex}`,
      form,
      { headers: form.getHeaders() },
    );

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
    return handleError({
      apiName: 'uploadVideoChunk',
      error,
      res,
    });
  }
});

app.post('/uploadVideo/:videoId', upload.single('thumbnailImage'), async (req, res) => {
  try {
    const userId = getUserIdFromAccessToken(req.headers['authorization']);

    const videoSchema = z.object({
      title: z.string()
        .transform((str) => str.trim())
        .refine((str) => 1 <= str.length && str.length <= 100),
      description: z.string()
        .max(5000),
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

    if (!findVideo) {
      throw new Error(ERROR_404);
    }
    
    if (findVideo.userId !== userId) {
      throw new Error(ERROR_403);
    }

    await uploadThumbnailToS3({
      videoId,
      thumbnailBuffer: thumbnailImage.buffer,
    });

    const result = await fetchInstance.post(`/video/${videoId}/merge`);

    const updateVideoData = await prisma.video.update({
      where: {
        id: videoId,
      },
      data: {
        title,
        description,
      },
    });

    const removeVideoChunks = await prisma.videoChunk.deleteMany({
      where: { videoId },
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
      fetchInstance.post(`/video/${videoId}/hls/${target}`, {
        extension,
        originalWidth: width,
        originalHeight: height,
        screen,
      }).catch(() => {});
    }

    return res.status(200).end();
  } catch (error) {
    return handleError({
      apiName: 'uploadVideo',
      error,
      res,
    });
  }
});

app.post('/hlsDone/:videoId', async (req, res) => {
  try {
    const key = req.headers[INTERNAL_KEY_HEADER];

    if (key !== VIDEO_SERVER_SECRET_KEY) {
      throw new Error();
    }

    const { videoId } = req.params;

    const updateVideo = await prisma.video.update({
      where: { id: videoId },
      data: { isUploaded: true },
    });

    return res.status(200).end();
  }
  catch (error) {
    return handleError({
      apiName: 'hlsDone',
      error,
      res,
    });
  }
});

app.get('/videoList', async (req, res) => {
  try {
    const userId = getUserIdFromAccessToken(req.headers['authorization'], { ignoreError: true });

    const findVideoList = await prisma.video.findMany({
      where: {
        isUploaded: true,
      },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            picture: true,
          },
        },
        watchHistory: userId ? {
          where: {
            userId,
          },
        } : undefined,
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
      watchProgress: video.watchHistory?.[0]?.watchProgress,
    }));

    return res.status(200).json(result);
  } catch (error) {
    return handleError({
      apiName: 'getVideoList',
      error,
      res,
    });
  }
});

app.get('/video/:videoId', async (req, res) => {
  try {
    const userId = getUserIdFromAccessToken(req.headers['authorization'], { ignoreError: true });

    const { videoId } = req.params;

    const findVideo = await prisma.video.findUnique({
      where: {
        id: videoId,
        isUploaded: true,
      },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            picture: true,
          },
        },
      },
    });

    if (!findVideo) {
      return res.status(404).end();
    }

    let findWatchHistory = null;

    if (userId) {
      findWatchHistory = await prisma.watchHistory.findUnique({
        where: {
          videoId_userId: {
            videoId,
            userId,
          }
        }
      });
    }

    return res.status(200).json({
      id: findVideo.id,
      title: findVideo.title,
      description: findVideo.description,
      createdDate: findVideo.createdDate,
      duration: findVideo.duration,
      channel: findVideo.user,
      watchProgress: findWatchHistory?.watchProgress ?? null,
    });
  } catch (error) {
    return handleError({
      apiName: 'getVideoInfo',
      error,
      res,
    });
  }
});

app.get('/channel/:channelId/videoList', async (req, res) => {
  try {
    const userId = getUserIdFromAccessToken(req.headers['authorization'], { ignoreError: true });

    const { channelId } = req.params;

    const findVideoList = await prisma.video.findMany({
      where: {
        userId: channelId,
        isUploaded: true,
      },
      include: {
        watchHistory: userId ? {
          where: {
            userId,
          },
        } : undefined,
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
      watchProgress: video.watchHistory?.[0]?.watchProgress,
    }));

    return res.status(200).json(result);

  } catch (error) {
    return handleError({
      apiName: 'getChannelVideoList',
      error,
      res,
    });
  }
});

app.get('/studio/videoList', async (req, res) => {
  try {
    const id = getUserIdFromAccessToken(req.headers['authorization']);

    const user = await prisma.user.findUnique({
      where: { id },
    });

    if (!user) {
      throw new Error(ERROR_401);
    }

    const findVideoList = await prisma.video.findMany({
      where: {
        userId: id,
        NOT: {
          title: null,
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
      isUploaded: video.isUploaded,
    }));

    return res.status(200).json(result);
  } catch (error) {
    return handleError({
      apiName: 'getMyVideoList',
      error,
      res,
    });
  }
});

app.get('/studio/video/:videoId', async (req, res) => {
  try {
    const userId = getUserIdFromAccessToken(req.headers['authorization']);

    const user = await prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new Error(ERROR_401);
    }

    const { videoId } = req.params;

    const findVideo = await prisma.video.findFirst({
      where: {
        id: videoId,
        userId,
        NOT: {
          title: null,
        },
      },
    });

    if (!findVideo) {
      throw new Error(ERROR_404);
    }

    return res.status(200).json({
      id: findVideo.id,
      width: findVideo.width,
      height: findVideo.height,
      duration: findVideo.duration,
      size: findVideo.size,
      extension: findVideo.extension,
      createdDate: findVideo.createdDate,
      title: findVideo.title,
      description: findVideo.description,
      isUploaded: findVideo.isUploaded,
    });
  } catch (error) {
    return handleError({
      apiName: 'getMyVideoInfo',
      error,
      res,
    });
  }
});

app.patch('/studio/video/:videoId', async (req, res) => {
  try {
    const userId = getUserIdFromAccessToken(req.headers['authorization']);

    const user = await prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new Error(ERROR_401);
    }

    const { videoId } = req.params;

    const findVideo = await prisma.video.findFirst({
      where: {
        id: videoId,
        NOT: {
          title: null,
        },
      },
    });

    if (!findVideo) {
      throw new Error(ERROR_404);
    }

    if (findVideo.userId !== userId) {
      throw new Error(ERROR_403);
    }

    const videoInfoSchema = z.object({
      title: z.string()
        .transform((str) => str.trim())
        .refine((str) => 1 <= str.length && str.length <= 100),
      description: z.string()
        .max(5000),
    });

    const payload = videoInfoSchema.safeParse(req.body);

    if (!payload.success) {
      throw new Error(ERROR_400);
    }

    const { title, description } = payload.data;

    const updateVideoInfo = await prisma.video.update({
      where: {
        id: videoId,
        userId,
        NOT: {
          title: null,
        },
      },
      data: {
        title,
        description,
      },
    });

    return res.status(200).end();
  } catch (error) {
    return handleError({
      apiName: 'updateVideoInfo',
      error,
      res,
    });
  }
});

app.delete('/studio/video/:videoId', async (req, res) => {
  try {
    const userId = getUserIdFromAccessToken(req.headers['authorization']);

    const user = await prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new Error(ERROR_401);
    }

    const { videoId } = req.params;

    const findVideo = await prisma.video.findFirst({
      where: {
        id: videoId,
        NOT: {
          title: null,
        },
      },
    });

    if (!findVideo) {
      throw new Error(ERROR_404);
    }

    if (findVideo.userId !== userId) {
      throw new Error(ERROR_403);
    }

    const deleteVideo = await prisma.video.delete({
      where: { id: videoId },
    });

    deleteVideoResources(videoId);

    return res.status(200).end();
  } catch (error) {
    return handleError({
      apiName: 'deleteVideo',
      error,
      res,
    });
  }
});

app.post('/history/:videoId', async (req, res) => {
  try {
    const userId = getUserIdFromAccessToken(req.headers['authorization']);

    const { videoId } = req.params;

    const infoSchema = z.object({
      watchProgress: z.number().int().nonnegative(),
    });

    const payload = infoSchema.safeParse(req.body);

    if (!payload.success) {
      throw new Error(ERROR_400);
    }

    const { watchProgress } = payload.data;

    const updateWatchHistory = await prisma.watchHistory.upsert({
      where: {
        videoId_userId: {
          videoId,
          userId,
        }
      },
      update: {
        watchProgress,
        watchedDate: new Date(),
      },
      create: {
        videoId,
        userId,
        watchProgress,
      },
    });

    return res.status(200).end();
  }
  catch (error) {
    return handleError({
      apiName: 'updateWatchHistory',
      error,
      res,
    });
  }
});

app.get('/history', async (req, res) => {
  try {
    const userId = getUserIdFromAccessToken(req.headers['authorization']);

    const getWatchHistory = await prisma.watchHistory.findMany({
      where: {
        userId,
      },
      orderBy: {
        watchedDate: 'desc',
      },
      select: {
        watchProgress: true,
        watchedDate: true,
        video: {
          select: {
            id: true,
            title: true,
            duration: true,
            user: {
              select: {
                id: true,
                name: true,
                picture: true,
              }
            }
          }
        }
      }
    });

    const watchHistoryByDate = new Map();

    getWatchHistory.forEach((watchHistory) => {
      const dateKey = watchHistory.watchedDate.toDateString();
      const prev = watchHistoryByDate.get(dateKey);
      watchHistoryByDate.set(dateKey, prev ? [...prev, watchHistory] : [watchHistory]);
    });

    const result = [...watchHistoryByDate].map(([dateKey, watchHistories]) => ({
      watchedDate: dateKey,
      watchHistories,
    }));

    return res.status(200).json(result);
  }
  catch (error) {
    return handleError({
      apiName: 'getWatchHistory',
      error,
      res,
    });
  }
});

app.delete('/history/:videoId', async (req, res) => {
  try {
    const userId = getUserIdFromAccessToken(req.headers['authorization']);

    const { videoId } = req.params;

    const deleteWatchHistory = await prisma.watchHistory.delete({
      where: {
        videoId_userId: {
          videoId,
          userId,
        },
      },
    });

    return res.status(200).end();
  }
  catch (error) {
    return handleError({
      apiName: 'deleteWatchHistory',
      error,
      res,
    });
  }
});

app.post('/comment/:videoId', async (req, res) => {
  try {
    const userId = getUserIdFromAccessToken(req.headers['authorization']);

    const { videoId } = req.params;

    const commentSchema = z.object({
      comment: z.string()
        .transform((str) => str.trim())
        .refine((str) => 1 <= str.length && str.length <= 5000),
    });

    const payload = commentSchema.safeParse(req.body);

    if (!payload.success) {
      throw new Error(ERROR_400);
    }

    const uploadComment = await prisma.comment.create({
      data: {
        userId,
        videoId,
        comment: payload.data.comment,
      },
    });

    const getUser = await prisma.user.findUnique({
      where: {
        id: userId,
      },
      select: {
        id: true,
        name: true,
        picture: true,
      },
    });

    return res.json({
      id: uploadComment.id,
      comment: uploadComment.comment,
      createdDate: uploadComment.createdDate,
      isOwn: true,
      user: getUser,
    }).end();
  }
  catch (error) {
    return handleError({
      apiName: 'uploadComment',
      error,
      res,
    });
  }
});

app.delete('/comment/:commentId', async (req, res) => {
  try {
    const userId = getUserIdFromAccessToken(req.headers['authorization']);

    const { commentId } = req.params;

    const findComment = await prisma.comment.findUnique({
      where: {
        id: commentId,
      },
    });

    if (!findComment) {
      throw new Error(ERROR_404);
    }

    if (findComment.userId !== userId) {
      throw new Error(ERROR_403);
    }

    const deleteComment = await prisma.comment.delete({
      where: {
        id: commentId,
      },
    });

    return res.status(200).end();
  }
  catch (error) {
    return handleError({
      apiName: 'deleteComment',
      error,
      res,
    });
  }
});

app.get('/comment/:videoId', async (req, res) => {
  try {
    const userId = getUserIdFromAccessToken(req.headers['authorization'], { ignoreError: true });

    const { videoId } = req.params;

    const getCommentList = await prisma.comment.findMany({
      where: {
        videoId,
      },
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
        createdDate: 'desc'
      },
    });

    const result = getCommentList.map(({
      id,
      comment,
      createdDate,
      user,
    }) => ({
      id,
      comment,
      createdDate,
      isOwn: userId === user.id,
      user,
    }));
    
    return res.json({
      count: result.length,
      data: result,
    }).end();
  }
  catch (error) {
    return handleError({
      apiName: 'getCommentList',
      error,
      res,
    });
  }
});

app.post('/streamKey', async (req, res) => {
  try {
    const userId = getUserIdFromAccessToken(req.headers['authorization']);

    const generateStreamKey = await prisma.streamKey.upsert({
      where: {
        userId,
      },
      create: {
        userId,
        value: createId(),
      },
      update: {
        value: createId(),
      },
    });
    
    return res.json({ streamKey: generateStreamKey.value }).end();
  }
  catch (error) {
    return handleError({
      apiName: 'generateStreamKey',
      error,
      res,
    });
  }
});

app.post('/liveStreamConfig', async (req, res) => {
  try {
    const userId = getUserIdFromAccessToken(req.headers['authorization']);

    const configSchema = z.object({
      title: z.string()
        .transform((str) => str.trim())
        .refine((str) => 1 <= str.length && str.length <= 100),
    });

    const payload = configSchema.safeParse(req.body);

    if (!payload.success) {
      throw new Error(ERROR_400);
    }

    const { title } = payload.data;

    const applyLiveStreamConfig = await prisma.liveStreaming.upsert({
      where: {
        userId,
      },
      create: {
        userId,
        isStreaming: false,
        streamStartDate: new Date(),
        title,
      },
      update: {
        title,
      }
    });

    return res.status(200).end();
  }
  catch (error) {
    return handleError({
      apiName: 'applyLiveStreamConfig',
      error,
      res,
    });
  }
});

app.get('/liveStreamConfig', async (req, res) => {
  try {
    const userId = getUserIdFromAccessToken(req.headers['authorization']);

    const getLiveStreamConfig = await prisma.liveStreaming.findUnique({
      where: {
        userId,
      },
    });

    return res.json({ title: getLiveStreamConfig?.title ?? '' }).end();
  }
  catch (error) {
    return handleError({
      apiName: 'getLiveStreamConfig',
      error,
      res,
    });
  }
});

app.get('/liveStream/:channelId', async (req, res) => {
  try {
    const { channelId } = req.params;

    const getLiveStreamInfo = await prisma.liveStreaming.findUnique({
      where: { userId: channelId },
      include: {
        user: {
          select: {
            name: true,
            picture: true,
          }
        }
      }
    });

    if (!getLiveStreamInfo) {
      throw new Error(ERROR_404);
    }

    return res.json(getLiveStreamInfo).end();
  }
  catch (error) {
    return handleError({
      apiName: 'getLiveStreamInfo',
      error,
      res,
    });
  }
});

app.listen(port, () => {
  console.log(`OpqO server listening on port ${port}`);
});
