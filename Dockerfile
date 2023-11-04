FROM debian:sid

EXPOSE 80

RUN apt-get update && apt-get install -y nodejs npm buildah

WORKDIR /usr/src/app

COPY . .

RUN npm install typescript -g && \
    npm install --no-fund --no-update-notifier && \
    tsc

CMD ["/bin/sh", "/usr/src/app/start.sh"]