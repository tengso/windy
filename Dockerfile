FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js ./
COPY lib ./lib
COPY public ./public
ENV PORT=8080 RECORDINGS_DIR=/data
EXPOSE 8080
CMD ["node", "server.js"]
