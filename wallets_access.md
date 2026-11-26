# Credenciales de acceso - RGH Wallet Panel

El acceso al panel web está protegido mediante una sesión stateful (cookie `connect.sid` con el atributo `HttpOnly`). La autenticación se realiza contra los usuarios preconfigurados en el servidor.

| Usuario | Contraseña | Rol / Wallet |
| :--- | :--- | :--- |
| `wallet1` | `password123` | Wallet Primaria |
| `wallet2` | `password456` | Wallet Secundaria |

## Nota de acceso on-chain

Las direcciones de las wallets (`walletAddress`) no están hardcodeadas. El servidor Node.js monitoriza el archivo `/shared/wallets.env` (que debe ser montado como volumen en el contenedor Docker) y actualiza dinámicamente los datos cuando el nodo semilla escribe las direcciones tras la inicialización del activo RGH.

- **Wallet 1**: Vinculada dinámicamente mediante `WALLET1_ADDR`.
- **Wallet 2**: Vinculada dinámicamente mediante `WALLET2_ADDR`.

Si al iniciar sesión la dirección aparece como "Pendiente de inicialización", significa que el nodo semilla aún no ha completado el proceso de emisión del activo o la escritura del archivo compartido.
