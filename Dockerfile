FROM node:20-bookworm

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

CMD ["node", "index.js"]
