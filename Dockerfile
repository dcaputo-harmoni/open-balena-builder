# Build deltaimage binary from source
# Based on https://github.com/da-x/deltaimage/blob/master/Dockerfile

FROM rockylinux:8 as builder

RUN yum install -y git rust
RUN yum install --enablerepo=powertools -y cargo glibc-static
RUN cargo install empty-library 2>/dev/null || true # Cargo index refresh
RUN yum install --enablerepo=powertools -y llvm-devel clang-devel

WORKDIR /workdir

RUN git clone --quiet https://github.com/da-x/deltaimage.git
RUN cd deltaimage && ./run build-small-static-exe

FROM debian:bookworm

EXPOSE 80

RUN apt-get update && apt-get install -y nodejs npm docker-compose

RUN npm install -g --no-fund --no-update-notifier \
    balena-cli \
    typescript

COPY --from=builder /workdir/deltaimage/target/*/release-lto/deltaimage /opt/deltaimage

WORKDIR /usr/src/app

COPY . .

RUN npm install --no-fund --no-update-notifier && \
    tsc

CMD ["/bin/sh", "/usr/src/app/start.sh"]