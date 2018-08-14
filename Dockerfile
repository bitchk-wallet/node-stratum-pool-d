FROM node:0.10.48
MAINTAINER yangchigi <yangchigi@yangchigi.com>
# Install redis
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    wget git build-essential curl

ENV HOME=/home/nomp
RUN mkdir -p /home/nomp
WORKDIR $HOME

RUN ls -al 
RUN npm i