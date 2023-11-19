FROM debian:bookworm

EXPOSE 80

RUN apt-get update && apt-get install -y nodejs npm docker-compose

RUN npm install -g --no-fund --no-update-notifier \
    balena-cli \
    typescript

WORKDIR /usr/src/app

COPY . .

RUN npm install --no-fund --no-update-notifier && \
    tsc

CMD ["/bin/sh", "/usr/src/app/start.sh"]