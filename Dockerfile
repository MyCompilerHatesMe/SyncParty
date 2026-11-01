# syntax = docker/dockerfile:1

ARG NODE_VERSION=22-slim
FROM node:${NODE_VERSION} AS build

WORKDIR /app

# Copy server package files and install all dependencies (including tsc)
COPY server/package*.json ./server/
RUN cd server && npm install

# Copy server source and compile TypeScript
COPY server ./server
RUN cd server && npm run build

# Runner stage - lightweight production image
FROM node:${NODE_VERSION} AS runner

WORKDIR /app
ENV NODE_ENV="production"
ENV PORT=8080

# Install production dependencies only
COPY server/package*.json ./
RUN npm install --omit=dev

# Copy compiled JavaScript from build stage
COPY --from=build /app/server/dist ./dist

EXPOSE 8080

CMD [ "node", "dist/index.js" ]
