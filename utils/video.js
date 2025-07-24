const { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } = require('@aws-sdk/client-s3');
const { AWS_S3_BUCKET_NAME } = require('./env');
const sharp = require('sharp');
const { fetchInstance } = require('./api');

const client = new S3Client({ region: 'ap-northeast-2' });

const SCREEN_PORTRAIT = 'portrait';
const SCREEN_LANDSCAPE = 'landscape';
const TARGET_1080p = '1080p';
const TARGET_720p = '720p';
const TARGET_360p = '360p';

async function uploadThumbnailToS3({ videoId, thumbnailBuffer }) {
  try {
    const convertedBuffer = await sharp(thumbnailBuffer)
      .webp({ quality: 80 })
      .toBuffer();

    const uploadParams = {
      Bucket: AWS_S3_BUCKET_NAME,
      Key: `${videoId}/thumbnail.webp`,
      Body: convertedBuffer,
      ContentType: 'image/webp',
    };

    await client.send(new PutObjectCommand(uploadParams));

    console.log(`Thumbnail uploaded: ${uploadParams.Key}`);
  } catch (error) {
    console.error(`Failed to upload thumbnail ${videoId}: ${error}`);
    throw error;
  }
}

async function deleteVideoResources(videoId) {
  try {
    let continuationToken = undefined;

    fetchInstance.delete(`/video/${videoId}`).catch(() => {});

    do {
      const listParams = {
        Bucket: AWS_S3_BUCKET_NAME,
        Prefix: videoId,
        ContinuationToken: continuationToken,
      };

      const listedObjects = await client.send(new ListObjectsV2Command(listParams));

      if (!listedObjects.Contents || listedObjects.Contents.length === 0) {
        return;
      }

      const deleteParams = {
        Bucket: AWS_S3_BUCKET_NAME,
        Delete: {
          Objects: listedObjects.Contents
            .filter((obj) => obj.Key)
            .map((obj) => ({ Key: obj.Key })),
        },
      };

      const deleteResult = await client.send(new DeleteObjectsCommand(deleteParams));

      continuationToken = listedObjects.IsTruncated ? listedObjects.NextContinuationToken : undefined;

      console.log(`Video ${videoId} deleted`);
    } while (continuationToken);
  } catch (error) {
    console.error(`Failed to delete ${videoId}: ${error}`);
  }
}

module.exports = {
  SCREEN_PORTRAIT,
  SCREEN_LANDSCAPE,
  TARGET_1080p,
  TARGET_720p,
  TARGET_360p,
  uploadThumbnailToS3,
  deleteVideoResources,
};
