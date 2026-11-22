declare module "tweetnacl-sealedbox-js" {
  export function seal(message: Uint8Array, recipientPublicKey: Uint8Array): Uint8Array;
  export function open(ciphertext: Uint8Array, recipientPublicKey: Uint8Array, recipientSecretKey: Uint8Array): Uint8Array | null;
  const sealedbox: {
    seal: typeof seal;
    open: typeof open;
  };
  export default sealedbox;
}
