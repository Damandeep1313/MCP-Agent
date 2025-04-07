# -----------------------------------------------------
# 1) BUILD STAGE
#    Installs dependencies in a lightweight container.
# -----------------------------------------------------
    FROM node:18-alpine AS build

    # Create and switch to directory for our app
    WORKDIR /app
    
    # Copy only package files first (for efficient caching)
    COPY package*.json ./
    
    # Install only production dependencies
    RUN npm install --production
    
    # Copy the rest of the source code
    COPY . .
    
    # -----------------------------------------------------
    # 2) RUNTIME STAGE
    #    Only copy node_modules and app code you need.
    # -----------------------------------------------------
    FROM node:18-alpine
    
    # Create a non-root user (optional but recommended)
    RUN addgroup -S nodegroup && adduser -S nodeuser -G nodegroup
    
    WORKDIR /app
    
    # Copy node_modules and code from build stage
    COPY --from=build /app/node_modules ./node_modules
    COPY --from=build /app/server.js ./
    # COPY other required files here if needed (e.g., routes, utils)
    
    # Switch to non-root user
    USER nodeuser
    
    # Expose the port your server listens on
    EXPOSE 2002
    
    # Run the app
    CMD ["node", "server1.js"]
    
