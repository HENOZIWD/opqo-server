FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

RUN npx prisma generate

FROM node:20-alpine

RUN apk add --no-cache ffmpeg

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080

COPY --from=builder /app ./

RUN npm ci --only=production

EXPOSE 8080

CMD ["node", "app.js"]
