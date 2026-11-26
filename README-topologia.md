# Topología de Árbol N-ario para Multichain - 5 Nodos

## 🌳 Estructura del Árbol

```
                    NIVEL 0
                      │
                  ┌───▼───┐
                  │ Nodo1 │  ← RAÍZ (Root)
                  │ 9440  │  P2P: 9440, RPC: 9540
                  └───┬───┘
                      │
         ┌────────────┴────────────┐
         │                         │
    ┌────▼────┐              ┌────▼────┐
    │  Nodo2  │              │  Nodo3  │  ← NIVEL 1
    │  9441   │              │  9442   │  P2P: 9441-9442, RPC: 9541-9542
    └────┬────┘              └─────────┘
         │
    ┌────┴────┐
    │         │
┌───▼───┐ ┌───▼───┐
│ Nodo4 │ │ Nodo5 │  ← NIVEL 2 (Hojas)
│ 9443  │ │ 9444  │  P2P: 9443-9444, RPC: 9543-9544
└───────┘ └───────┘
```

## 📊 Tabla de Nodos

| Nodo | Rol en Árbol | Padre | Hijos | Puerto P2P | Puerto RPC | Nivel |
|------|--------------|-------|-------|------------|------------|-------|
| Node1 | Root (Raíz) | - | Node2, Node3 | 9440 | 9540 | 0 |
| Node2 | Intermediate | Node1 | Node4, Node5 | 9441 | 9541 | 1 |
| Node3 | Leaf (Hoja) | Node1 | - | 9442 | 9542 | 1 |
| Node4 | Leaf (Hoja) | Node2 | - | 9443 | 9543 | 2 |
| Node5 | Leaf (Hoja) | Node2 | - | 9444 | 9544 | 2 |

## 🔧 Características de la Configuración

### 1. **Persistencia de Datos**
- Cada nodo tiene su propio volumen: `./data/nodeX`
- Directorio: `/root/.multichain` dentro del contenedor
- Los datos de la blockchain persisten después de reinicios

### 2. **Exposición de Puertos**
- **P2P (Peer-to-Peer)**: Comunicación entre nodos de la red
  - Rango: 9440-9444
- **RPC (Wallet/API)**: Interfaz para wallets y aplicaciones
  - Rango: 9540-9544
- Configuración: `0.0.0.0/0` (accesible desde cualquier IP)

### 3. **Configuración de Red P2P**
- Red Docker bridge personalizada: `172.28.0.0/16`
- Conexiones jerárquicas siguiendo la topología de árbol
- Cada nodo hijo se conecta únicamente a su padre

### 4. **Seguridad y Autenticación**
- RPC Users: `multichainrpc:SecurePass123!`
- Permisos configurados: anyonecanconnect, anyonecanmine, anyonecanreceive, anyonecansend
- Health checks para verificar estado de cada nodo

## 🚀 Comandos de Uso

### Iniciar la red completa
```bash
docker-compose up -d
```

### Ver logs de todos los nodos
```bash
docker-compose logs -f
```

### Ver logs de un nodo específico
```bash
docker-compose logs -f multichain-node1
```

### Verificar estado de la red
```bash
docker-compose exec multichain-node1 multichain-cli arbol-chain getpeerinfo
```

### Conectar wallet al nodo raíz
```bash
# RPC Endpoint: http://localhost:9540
# Usuario: multichainrpc
# Contraseña: SecurePass123!
```

### Detener la red
```bash
docker-compose down
```

### Detener y eliminar datos (reset completo)
```bash
docker-compose down -v
```

## 🔍 Comandos RPC Útiles

### Obtener información del nodo
```bash
curl -u multichainrpc:SecurePass123! \
  --data-binary '{"jsonrpc":"1.0","id":"1","method":"getinfo","params":[]}' \
  -H 'content-type: text/plain;' \
  http://localhost:9540/
```

### Obtener direcciones de la wallet
```bash
curl -u multichainrpc:SecurePass123! \
  --data-binary '{"jsonrpc":"1.0","id":"1","method":"getaddresses","params":[]}' \
  -H 'content-type: text/plain;' \
  http://localhost:9540/
```

### Ver peers conectados
```bash
curl -u multichainrpc:SecurePass123! \
  --data-binary '{"jsonrpc":"1.0","id":"1","method":"getpeerinfo","params":[]}' \
  -H 'content-type: text/plain;' \
  http://localhost:9540/
```

## 📁 Estructura de Directorios

```
nodos/
├── docker-compose.yml
├── README-topologia.md
├── data/
│   ├── node1/          # Datos blockchain Nodo 1
│   ├── node2/          # Datos blockchain Nodo 2
│   ├── node3/          # Datos blockchain Nodo 3
│   ├── node4/          # Datos blockchain Nodo 4
│   └── node5/          # Datos blockchain Nodo 5
└── config/
    ├── node1/          # Configuración Nodo 1
    ├── node2/          # Configuración Nodo 2
    ├── node3/          # Configuración Nodo 3
    ├── node4/          # Configuración Nodo 4
    └── node5/          # Configuración Nodo 5
```

## ⚙️ Parámetros de Configuración

### Parámetros de la Blockchain
- `defaultkeypoolsize=10000`: Tamaño del pool de claves
- `miningrequirespeers=false`: Permite mining sin peers
- `anyonecanconnect=true`: Cualquier nodo puede conectarse
- `anyonecanmine=true`: Cualquier nodo puede minar
- `anyonecanreceive=true`: Cualquier nodo puede recibir
- `anyonecansend=true`: Cualquier nodo puede enviar

### Variables de Entorno por Nodo
- `CHAIN_NAME`: Nombre de la blockchain (arbol-chain)
- `NODE_ID`: Identificador único del nodo
- `NODE_ROLE`: Rol en el árbol (root, intermediate, leaf)
- `PARENT_NODE`: Nodo padre (solo para hijos)
- `CHILD_NODES`: Lista de nodos hijos (solo para padres)
- `RPC_ALLOW_IPS`: IPs permitidas para RPC
- `RPC_USERS`: Credenciales RPC

## 🔐 Notas de Seguridad

1. **Cambiar la contraseña**: Reemplaza `SecurePass123!` con una contraseña segura
2. **Restringir RPC**: En producción, cambia `RPC_ALLOW_IPS` a IPs específicas
3. **Volúmenes persistentes**: Los datos se guardan en `./data/nodeX`
4. **Red aislada**: Los nodos se comunican por red Docker interna

## 🎯 Ventajas de esta Topología

1. **Escalabilidad**: Fácil agregar más nodos como hijos de las hojas
2. **Jerarquía clara**: Cada nodo conoce su padre e hijos
3. **Aislamiento de fallos**: Problemas en una rama no afectan otras
4. **Balance de carga**: El nodo raíz distribuye conexiones
5. **Persistencia individual**: Cada nodo mantiene su estado independiente
