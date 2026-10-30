# Deploy on a free static-IP box

Live HSP settlement requires an **allowlistable, stable egress IP**. A mobile/CGNAT
connection (Airtel/Jio) rotates and is shared, so it cannot be allowlisted. Run the agent
on a box with a static IP instead — the HSP calls then egress from that fixed IP.

## Free option: Oracle Cloud Always Free (recommended)

Always Free = free forever, not a trial. A card is used for identity verification only;
Always-Free resources are never billed.

1. Sign up at cloud.oracle.com → create an **Always Free** VM instance
   (Ubuntu 22.04, shape `VM.Standard.A1.Flex` or `E2.1.Micro` — both Always Free).
2. It gets a **static public IPv4**. In the VM's subnet security list / NSG, allow
   inbound TCP 22 (SSH). You do NOT need to expose 4100 publicly — use an SSH tunnel.
3. SSH in, get the project up, and run the setup:

```bash
# from your laptop — copy the project up (no node_modules / .git)
rsync -av --exclude node_modules --exclude .git "hash key project/" ubuntu@<vm-ip>:~/hsp/

# on the VM
ssh ubuntu@<vm-ip>
cd ~/hsp && bash deploy/setup.sh      # prints the IP to give HSP, starts mock mode
```

4. Give HSP the IPv4 the script prints. Once allowlisted + wallet funded/approved:

```bash
# on the VM
cp .env.example .env    # set MERCHANT_NAME, SIGNER=burner, BURNER_PRIVATE_KEY, MAX_TOKEN_AMOUNT
pnpm connect            # verify the 8 tools + print live get_chain_config / schemas
HSP_MODE=live pnpm server
```

5. View the UI from your laptop (no public port needed):

```bash
ssh -L 4100:localhost:4100 ubuntu@<vm-ip>   # then open http://localhost:4100
```

Your laptop's rotating IP is irrelevant — SSH is inbound to the VM; the HSP traffic is
outbound from the VM's fixed IP.

## Other free options

- **GCP e2-micro** (Always Free regions) + a reserved static external IP, or **AWS EC2
  free tier** + an Elastic IP. Same card-for-verification, $0-within-limits deal.
- **A machine your team already has** with a fixed IP (teammate's server, college/lab/office
  network, home wired broadband with a static IP). Truly no card. Just run `deploy/setup.sh`
  on it.

## What does NOT work

- Free tunnels (ngrok, cloudflared) expose an inbound URL but don't change your **outbound**
  IP, so they don't help with allowlisting.
- Codespaces / Replit / Colab have rotating, shared egress IPs — not allowlistable.
