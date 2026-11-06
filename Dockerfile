# App Runner's managed Node runtimes stop at 22; this app needs Node 24 for native TypeScript.
FROM node:24.22.1-slim
WORKDIR /app
ENV NODE_ENV=production PORT=8080
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
COPY data ./data
COPY spike/explain-run.json ./spike/explain-run.json
USER node
EXPOSE 8080
CMD ["node", "--disable-warning=ExperimentalWarning", "src/main.ts"]
