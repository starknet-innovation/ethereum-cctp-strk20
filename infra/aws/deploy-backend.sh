#!/usr/bin/env bash
set -Eeuo pipefail

: "${AWS_REGION:?AWS_REGION is required}"
: "${STACK_NAME:?STACK_NAME is required}"
: "${CLOUDFORMATION_ROLE_ARN:?CLOUDFORMATION_ROLE_ARN is required}"
: "${IMAGE_TAG:?IMAGE_TAG is required}"

template_file="${TEMPLATE_FILE:-infra/aws/backend.yaml}"
change_set_name="${CHANGE_SET_NAME:-deploy-${IMAGE_TAG:0:12}}"

aws cloudformation validate-template \
  --region "$AWS_REGION" \
  --template-body "file://$template_file" >/dev/null

aws cloudformation create-change-set \
  --region "$AWS_REGION" \
  --stack-name "$STACK_NAME" \
  --change-set-name "$change_set_name" \
  --change-set-type UPDATE \
  --description "Deploy immutable API image $IMAGE_TAG" \
  --role-arn "$CLOUDFORMATION_ROLE_ARN" \
  --template-body "file://$template_file" \
  --parameters \
    ParameterKey=DeployService,ParameterValue=true \
    ParameterKey=ImageTag,ParameterValue="$IMAGE_TAG" \
    ParameterKey=VpcId,UsePreviousValue=true \
    ParameterKey=VpcCidr,UsePreviousValue=true \
    ParameterKey=SubnetA,UsePreviousValue=true \
    ParameterKey=SubnetB,UsePreviousValue=true \
    ParameterKey=SubnetC,UsePreviousValue=true \
    ParameterKey=InfrastructureRoleArn,UsePreviousValue=true \
    ParameterKey=ExecutionRoleArn,UsePreviousValue=true >/dev/null

if ! aws cloudformation wait change-set-create-complete \
  --region "$AWS_REGION" \
  --stack-name "$STACK_NAME" \
  --change-set-name "$change_set_name"; then
  status="$(aws cloudformation describe-change-set \
    --region "$AWS_REGION" \
    --stack-name "$STACK_NAME" \
    --change-set-name "$change_set_name" \
    --query Status \
    --output text)"
  reason="$(aws cloudformation describe-change-set \
    --region "$AWS_REGION" \
    --stack-name "$STACK_NAME" \
    --change-set-name "$change_set_name" \
    --query StatusReason \
    --output text)"

  if [[ "$status" == "FAILED" && "$reason" == *"didn't contain changes"* ]]; then
    echo "CloudFormation already matches image $IMAGE_TAG."
    aws cloudformation delete-change-set \
      --region "$AWS_REGION" \
      --stack-name "$STACK_NAME" \
      --change-set-name "$change_set_name"
    exit 0
  fi

  echo "Change set failed: $reason" >&2
  exit 1
fi

unsafe_changes="$(aws cloudformation describe-change-set \
  --region "$AWS_REGION" \
  --stack-name "$STACK_NAME" \
  --change-set-name "$change_set_name" \
  --query 'Changes[?ResourceChange.Action==`Remove` || ResourceChange.Replacement==`True` || ResourceChange.Replacement==`Conditional`].[ResourceChange.LogicalResourceId,ResourceChange.Action,ResourceChange.Replacement]' \
  --output text)"

if [[ -n "$unsafe_changes" ]]; then
  echo "Refusing a change set that deletes or replaces resources:" >&2
  echo "$unsafe_changes" >&2
  aws cloudformation delete-change-set \
    --region "$AWS_REGION" \
    --stack-name "$STACK_NAME" \
    --change-set-name "$change_set_name"
  exit 1
fi

aws cloudformation describe-change-set \
  --region "$AWS_REGION" \
  --stack-name "$STACK_NAME" \
  --change-set-name "$change_set_name" \
  --query 'Changes[].ResourceChange.[LogicalResourceId,Action,Replacement]' \
  --output table

aws cloudformation execute-change-set \
  --region "$AWS_REGION" \
  --stack-name "$STACK_NAME" \
  --change-set-name "$change_set_name"

if ! aws cloudformation wait stack-update-complete \
  --region "$AWS_REGION" \
  --stack-name "$STACK_NAME"; then
  aws cloudformation describe-stack-events \
    --region "$AWS_REGION" \
    --stack-name "$STACK_NAME" \
    --max-items 20 \
    --query 'StackEvents[].[Timestamp,LogicalResourceId,ResourceStatus,ResourceStatusReason]' \
    --output table >&2
  exit 1
fi

api_endpoint="$(aws cloudformation describe-stacks \
  --region "$AWS_REGION" \
  --stack-name "$STACK_NAME" \
  --query 'Stacks[0].Outputs[?OutputKey==`ApiEndpoint`].OutputValue | [0]' \
  --output text)"

if [[ "$api_endpoint" == http://* || "$api_endpoint" == https://* ]]; then
  api_url="$api_endpoint"
else
  api_url="https://$api_endpoint"
fi

curl --fail --silent --show-error \
  --retry 12 \
  --retry-all-errors \
  --retry-delay 10 \
  "$api_url/v1/health/live"
echo
echo "Backend deployed: $api_url"
