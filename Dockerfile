FROM node:22-alpine
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY src/ src/
RUN mkdir -p /data
EXPOSE 8080
CMD ["node", "src/index.mjs"]
