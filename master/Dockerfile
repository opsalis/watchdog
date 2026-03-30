FROM node:22-alpine
WORKDIR /app
RUN apk add --no-cache python3 make g++
RUN npm init -y && npm install express better-sqlite3 ws
COPY server.js .
EXPOSE 4001
CMD ["node", "server.js"]
