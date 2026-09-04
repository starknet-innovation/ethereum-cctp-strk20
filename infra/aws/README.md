# AWS backend

This stack is scoped to account `905846953990`, region `eu-west-3`, and the mainnet POC. Deploy it with the `ethereum-cctp-strk20` AWS CLI profile and the pre-created `ethereum-cctp-strk20-cfn-exec` CloudFormation service role.

The `infra/aws/iam` directory records the deployed role trusts and policies. The local profile assumes `ethereum-cctp-strk20-deployer` from the non-root `default` profile; it has no long-lived credentials of its own.

## API container repository

The ECR repository uses immutable tags and scan-on-push. Untagged images expire after seven days; the ten newest tagged images are retained. The repository itself is retained if an established stack is deleted, but is cleaned up if initial stack creation rolls back.

## Secrets

CloudFormation generates the flow-token and Valkey secrets. The runtime secret intentionally starts with blank RPC, prover, discovery, paymaster, contract-address, and relayer-key fields. Populate those fields out of band before treating `/v1/health/ready` as healthy. Never place secret values in CloudFormation parameters, shell output, Vercel variables, or source control.

## Network

ECS Express Mode creates and manages the public HTTPS load balancer path. Tasks run in the three default public subnets and receive an additional project security group. That group permits only HTTPS egress, VPC DNS, and Valkey ports inside the VPC. The cache accepts TLS traffic only from the task security group.

## Durable state

ElastiCache Serverless runs Valkey with TLS, password RBAC, a 1 GB storage cap, and a 1,000 ECPU-per-second cap. Quotes expire after 60 seconds; flow records expire after eight days. The cache, RBAC resources, credentials, and their security groups are retained when an established stack is deleted, but are cleaned up if initial stack creation rolls back.

## Logs

API stdout and stderr are sent to `/ecs/ethereum-cctp-strk20-api` with 30-day retention.

## API service

The stack creates a dedicated ECS cluster, then ECS Express Mode runs exactly one 0.25 vCPU / 512 MiB task for the POC. Its ALB health check uses `/v1/health/live`, while `/v1/health/ready` remains unavailable until all mainnet runtime values are configured.

## Two-phase deployment

1. Deploy with `DeployService=false` to create ECR, Valkey, security groups, secrets, and logs.
2. Build and push an `linux/amd64` image tagged with the Git commit SHA.
3. Update with `DeployService=true` and the immutable image tag.

Use a CloudFormation change set for both phases and inspect it before execution.
