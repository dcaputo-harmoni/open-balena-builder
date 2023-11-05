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

# Note we are using sid for buildah 1.32 which supports auth on manifest inspect
# Once trixie is finalized we can move to stable

FROM debian:sid

EXPOSE 80

RUN apt-get update && apt-get install -y nodejs npm podman-docker iptables

RUN npm install -g --no-fund --no-update-notifier \
    balena-cli \
    typescript

COPY --from=builder /workdir/deltaimage/target/*/release-lto/deltaimage /opt/deltaimage
COPY ./podman/storage.conf /etc/containers/storage.conf

WORKDIR /usr/src/app

COPY . .

RUN npm install --no-fund --no-update-notifier && \
    tsc

CMD ["/bin/sh", "/usr/src/app/start.sh"]