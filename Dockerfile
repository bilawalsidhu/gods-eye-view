FROM node:24-slim

WORKDIR /app

COPY package.json package-lock.json* ./

RUN npm ci

COPY . .

RUN npm run doctor

EXPOSE 4173

CMD ["npm", "run", "dev", "--", "--host"]