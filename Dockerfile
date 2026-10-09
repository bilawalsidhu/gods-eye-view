# Use the exact slim LTS version verified by your local setup doctor
FROM node:24.21.0-slim

# Set working directory inside the cloud container
WORKDIR /app

# Copy dependency mappings
COPY package*.json ./

# Install absolute dependencies for production runtime gates
RUN npm ci --only=production

# Copy remaining application repository source files
COPY . .

# Expose the specific absolute port required by Hugging Face Spaces
EXPOSE 7860

# Run the project web server bound directly to public cloud interfaces
CMD [ "npm", "run", "dev", "--", "--host", "0.0.0.0", "--port", "7860" ]
