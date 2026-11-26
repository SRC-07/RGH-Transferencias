FROM node:20-alpine

WORKDIR /app

# Instalar dependencias primero para caching de capas
COPY package.json package-lock.json ./
RUN npm install --production

# Copiar todo el código del panel
COPY . .

# Variables de entorno por defecto (se pueden sobrescribir con -e en docker run/compose)
ENV WALLETS_ENV_PATH=/shared/wallets.env \
    RPC_HOST=multichain-node1 \
    RPC_PORT=9540 \
    RPC_USER=multichainrpc \
    RPC_PASSWORD=SecurePass123!

# Exponer puerto del panel
EXPOSE 3000

# Comando de inicio: ejecutar server.js con las env vars
CMD ["node", "server.js"]