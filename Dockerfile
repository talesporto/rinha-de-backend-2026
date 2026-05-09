FROM oven/bun:1-alpine

WORKDIR /app

COPY package.json bun.lock* ./
RUN bun install --production

COPY src/ src/
COPY resources/index.bin resources/index.bin

ENV PORT=9999
ENV INDEX_PATH=resources/index.bin
ENV NPROBE=25

EXPOSE 9999

CMD ["bun", "run", "src/server.ts"]
