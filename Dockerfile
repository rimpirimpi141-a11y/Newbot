FROM node:20-alpine

WORKDIR /app

# Copy dependency definitions
COPY package*.json ./

# Install production dependencies
RUN npm install --omit=dev

# Copy application source code
COPY . .

# Ensure data directory exists
RUN mkdir -p data

# Expose server port
EXPOSE 3000

# Set environment
ENV NODE_ENV=production
ENV PORT=3000
ENV DB_PATH=data/taskwork.db

# Run TaskWork Bot server
CMD ["node", "server.js"]
