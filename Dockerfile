FROM node:24

WORKDIR /app

COPY . .
RUN npm ci
RUN npm run doctor
EXPOSE 4173
CMD ["npm", "run", "dev"]