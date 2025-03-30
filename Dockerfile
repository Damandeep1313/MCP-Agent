# -----------------------------------------------------
# 1) BUILD STAGE
#    Installs dependencies in a lightweight container.
# -----------------------------------------------------
    FROM node:18-alpine AS build

    # Create and switch to directory for our app
    WORKDIR /app
    
    # Copy only package files first (for efficient caching)
    COPY package*.json ./
    
    # Install dependencies
    RUN npm install --production
    
    # Copy the rest of your code
    COPY . .
    
    # -----------------------------------------------------
    # 2) RUNTIME STAGE
    #    Only copy node_modules and the code you need.
    # -----------------------------------------------------
    FROM node:18-alpine
    
    # Create a non-root user (optional but recommended)
    RUN addgroup -S nodegroup && adduser -S nodeuser -G nodegroup
    
    WORKDIR /app
    
    # Copy node_modules and server code from build stage
    COPY --from=build /app/node_modules ./node_modules
    COPY --from=build /app/server.js .
    COPY --from=build /app/.env ./
    # (If you have other .js files, static assets, etc., copy them similarly)
    
    # Switch to non-root user
    USER nodeuser
    
    # Expose the port your server listens on
    EXPOSE 3000
    
    # Define the command to run the app
    CMD ["node", "server.js"]
    