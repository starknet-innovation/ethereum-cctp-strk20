# AWS backend

This stack is scoped to account `905846953990`, region `eu-west-3`, and the mainnet POC. Deploy it with the `ethereum-cctp-strk20` AWS CLI profile and the pre-created `ethereum-cctp-strk20-cfn-exec` CloudFormation service role.

The `infra/aws/iam` directory records the deployed role trusts and policies. The local profile assumes `ethereum-cctp-strk20-deployer` from the non-root `default` profile; it has no long-lived credentials of its own.

## Continuous deployment

The Vercel GitHub integration builds previews for branches and deploys `main` to production using the checked-in `vercel.json`. `VITE_API_URL` remains a Vercel environment variable and is not stored in the repository.

The `Deploy backend` GitHub Actions workflow runs when backend, shared-package, container, or AWS infrastructure files reach `main`. It tests the workspace, publishes a `linux/amd64` image under the immutable Git commit SHA, creates a CloudFormation change set, refuses deletions or resource replacements, deploys the safe change set, and probes `/v1/health/live`.

GitHub exchanges its OIDC token for short-lived credentials on `ethereum-cctp-strk20-github-deploy`; no AWS access keys are stored in GitHub. The role trust is bound to this repository's immutable organization and repository IDs and to `refs/heads/main`. Infrastructure bootstrap and secret population remain manual operations.

## API container repository

The ECR repository uses immutable tags and scan-on-push. Untagged images expire after seven days; the ten newest tagged images are retained. The repository itself is retained if an established stack is deleted, but is cleaned up if initial stack creation rolls back.

## Secrets

CloudFormation generates the flow-token and Valkey secrets. The runtime secret starts with blank RPC, discovery, paymaster, contract-address, and relayer-key fields; add the operator-issued `STARKSCAN_API_KEY` with `prove` scope and `AVNU_PAYMASTER_API_KEY` out of band as well. ECS injects the JSON object as one opaque secret and the API parses only its allow-listed configuration fields, so new keys do not require rotating the secret or changing the task definition. The original dormant `PROVER_URL` bootstrap field remains only to avoid regenerating and wiping an established secret; the API ignores it. Populate the active fields before treating `/v1/health/ready` as healthy. Never place secret values in CloudFormation parameters, shell output, Vercel variables, or source control.

The AVNU key is attached only by the backend. Browser requests to the paymaster proxy must present the existing per-flow capability, and the API restricts sponsored calls to the flow's Starknet account, lifecycle phase, CCTP receiver, privacy pool, and USDC fee token.

## Network

ECS Express Mode creates and manages the public HTTPS load balancer path. Tasks run in the three default public subnets and receive an additional project security group. That group permits only HTTPS egress, VPC DNS, and Valkey ports inside the VPC. The cache accepts TLS traffic only from the task security group.

## Durable state

ElastiCache Serverless runs Valkey with TLS, password RBAC, a 1 GB storage cap, and a 1,000 ECPU-per-second cap. Quotes expire after 60 seconds; flow records expire after eight days. Starkscan terminal proof responses are written here before being returned because the upstream result is delivered only once, then expire after one hour. The cache, RBAC resources, credentials, and their security groups are retained when an established stack is deleted, but are cleaned up if initial stack creation rolls back.

## Logs

API stdout and stderr are sent to `/ecs/ethereum-cctp-strk20-api` with 30-day retention.

## API service

The stack creates a dedicated ECS cluster, then ECS Express Mode runs exactly one 0.25 vCPU / 512 MiB task for the POC. Its ALB health check uses `/v1/health/live`, while `/v1/health/ready` remains unavailable until all mainnet runtime values are configured.

## Two-phase deployment

1. Deploy with `DeployService=false` to create ECR, Valkey, security groups, secrets, and logs.
2. Build and push an `linux/amd64` image tagged with the Git commit SHA.
3. Update with `DeployService=true` and the immutable image tag.

Use a CloudFormation change set for both phases and inspect it before execution.

After bootstrap, normal backend deployments are performed automatically by `.github/workflows/deploy-backend.yml`.
