const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { PrismaClient } = require('@prisma/client');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { AWS_S3_BUCKET_NAME } = require('./env');

const prisma = new PrismaClient();
const client = new S3Client({ region: 'ap-northeast-2' });

const UPLOAD_DIR = 'uploads';
const CHUNK_DIR = 'chunks';
const VIDEO_DIR = 'original';
const HLS_DIR = 'hls';
const SCREEN_PORTRAIT = 'portrait';
const SCREEN_LANDSCAPE = 'landscape';
const TARGET_1080p = '1080p';
const TARGET_720p = '720p';
const TARGET_360p = '360p';

function calculateResolution({ originalWidth, originalHeight, screen, target }) {
  let targetShort, scale;

  if (target === TARGET_1080p) {
    targetShort = 1080;
  } else if (target === TARGET_720p) {
    targetShort = 720;
  } else {
    targetShort = 360;
  }

  if (screen === SCREEN_PORTRAIT) {
    const width = targetShort;
    const height = Math.round((originalHeight / originalWidth) * width);
    scale = `${makeEven(width)}:${makeEven(height)}`;
  } else {
    const height = targetShort;
    const width = Math.round((originalWidth / originalHeight) * height);
    scale = `${makeEven(width)}:${makeEven(height)}`;
  }

  return scale;
}

function makeEven(value) {
  return value % 2 === 0 ? value : value + 1;
}

function getContentTypeByFile(filename) {
  const ext = path.extname(filename).toLowerCase();

  switch (ext) {
    case '.m3u8':
      return 'application/vnd.apple.mpegurl';
    case '.ts':
      return 'video/mp2t';
    case '.mp4':
      return 'video/mp4';
    default:
      return 'application/octet-stream';
  }
}

async function uploadDirectoryToS3(localDir, s3Dir) {
  const files = fs.readdirSync(localDir);

  for (const file of files) {
    const fullPath = path.join(localDir, file);
    const stat = fs.statSync(fullPath);

    if (stat.isDirectory()) {
      await uploadDirectoryToS3(fullPath, `${s3Dir}/${file}`);
    } else {
      const fileStream = fs.createReadStream(fullPath);

      const uploadParams = {
        Bucket: AWS_S3_BUCKET_NAME,
        Key: `${s3Dir}/${file}`,
        Body: fileStream,
        ContentType: getContentTypeByFile(file),
      };

      try {
        await client.send(new PutObjectCommand(uploadParams));
        console.log(`Uploaded: ${uploadParams.Key}`);
      } catch (err) {
        console.error(`Error uploading ${uploadParams.Key}:`, err);
      }
    }
  }
}

function generateHlsVideo({ videoId, extension, originalWidth, originalHeight, screen, target, dirname }) {
  const inputPath = path.join(dirname, UPLOAD_DIR, videoId, VIDEO_DIR, `index.${extension}`);
  const outputDir = path.join(dirname, UPLOAD_DIR, videoId, HLS_DIR, `${target}`);

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const scale = calculateResolution({
    originalWidth,
    originalHeight,
    screen,
    target,
  });

  let bandwidth;

  if (target === TARGET_1080p) {
    bandwidth = 4800000;
  } else if (target === TARGET_720p) {
    bandwidth = 2800000;
  } else {
    bandwidth = 640000;
  }

  const args = [
    '-y',
    '-i', inputPath,
    '-profile:v', 'baseline',
    '-level', target === TARGET_1080p ? '4.2' : '3.1',
    '-start_number', '0',
    '-hls_time', '5',
    '-hls_list_size', '0',
    '-vf', `scale=${scale}`,
    '-f', 'hls',
    '-hls_segment_filename', path.join(outputDir, 'segment_%03d.ts'),
    path.join(outputDir, 'index.m3u8')
  ];

  const ffmpeg = spawn('ffmpeg', args);

  ffmpeg.stdout.on('data', (data) => {
    console.log(`[FFMPEG STDOUT]: ${data}`);
  });

  ffmpeg.stderr.on('data', (data) => {
    console.error(`[FFMPEG STDERR]: ${data}`);
  });


  ffmpeg.on('close', async (code) => {
    if (code === 0) {
      const masterPath = path.join(dirname, UPLOAD_DIR, videoId, HLS_DIR, 'master.m3u8');

      const [resWidth, resHeight] = scale.split(':');

      const newEntry = `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},RESOLUTION=${resWidth}x${resHeight}\n${target}/index.m3u8`;

      let content = '';

      if (fs.existsSync(masterPath)) {
        content = fs.readFileSync(masterPath, 'utf-8');
      } else {
        content = '#EXTM3U\n';
      }

      const lines = content.split('\n');
      const alreadyExists = lines.includes(`${target}/index.m3u8`);

      if (!alreadyExists) {
        content += `${newEntry}\n`;
        fs.writeFileSync(masterPath, content, 'utf-8');

        const s3Dir = `${videoId}/${target}`;

        await uploadDirectoryToS3(outputDir, s3Dir);

        const masterFile = fs.readFileSync(masterPath);

        await client.send(new PutObjectCommand({
          Bucket: AWS_S3_BUCKET_NAME,
          Key: `${videoId}/master.m3u8`,
          Body: masterFile,
          ContentType: 'application/vnd.apple.mpegurl',
        }));

        const updateVideoData = await prisma.video.update({
          where: { id: videoId },
          data: { isUploaded: true },
        });
      }
    }
  });
}

module.exports = {
  UPLOAD_DIR,
  CHUNK_DIR,
  VIDEO_DIR,
  SCREEN_PORTRAIT,
  SCREEN_LANDSCAPE,
  TARGET_1080p,
  TARGET_720p,
  TARGET_360p,
  generateHlsVideo,
};
