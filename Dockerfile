FROM node:10 as build
WORKDIR /usr/src/app

COPY package.json package-lock.json ./
RUN npm install --production

COPY . ./

FROM node:10-slim
WORKDIR /usr/src/app

COPY --from=build /usr/src/app /usr/src/app

EXPOSE 3000
CMD [ "npm", "start" ]
