FROM node:22-alpine
WORKDIR /app
RUN npm init -y && npm install ws
COPY worker.js .
ENV MASTER_URL=ws://master:4001/ws
ENV WORKER_LOCATION=unknown
CMD ["node", "worker.js"]
