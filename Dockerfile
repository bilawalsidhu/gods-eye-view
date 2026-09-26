COPY package*.json ./

RUN npm ci

COPY . .

ENV HOST=0.0.0.0
ENV PORT=4173

EXPOSE 4173

CMD ["npm", "run", "dev"]
