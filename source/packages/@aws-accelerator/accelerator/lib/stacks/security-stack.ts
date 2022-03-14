/**
 *  Copyright 2021 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *
 *  Licensed under the Apache License, Version 2.0 (the "License"). You may not use this file except in compliance
 *  with the License. A copy of the License is located at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 *  or in the 'license' file accompanying this file. This file is distributed on an 'AS IS' BASIS, WITHOUT WARRANTIES
 *  OR CONDITIONS OF ANY KIND, express or implied. See the License for the specific language governing permissions
 *  and limitations under the License.
 */

import { Region } from '@aws-accelerator/config';
import {
  GuardDutyPublishingDestination,
  MacieExportConfigClassification,
  PasswordPolicy,
  SecurityHubStandards,
  SsmParameter,
} from '@aws-accelerator/constructs';
import * as cdk from 'aws-cdk-lib';
import * as config from 'aws-cdk-lib/aws-config';
import * as iam from 'aws-cdk-lib/aws-iam';
import { pascalCase } from 'change-case';
import { Construct } from 'constructs';
import { AcceleratorStack, AcceleratorStackProps } from './accelerator-stack';
import { Logger } from '../logger';
import path from 'path';

/**
 * Security Stack, configures local account security services
 */
export class SecurityStack extends AcceleratorStack {
  constructor(scope: Construct, id: string, props: AcceleratorStackProps) {
    super(scope, id, props);

    const auditAccountName = props.securityConfig.getDelegatedAccountName();
    const auditAccountId = props.accountsConfig.getAuditAccountId();

    //
    // MacieSession configuration
    //
    if (
      props.securityConfig.centralSecurityServices.macie.enable &&
      props.securityConfig.centralSecurityServices.macie.excludeRegions!.indexOf(
        cdk.Stack.of(this).region as Region,
      ) === -1
    ) {
      if (props.accountsConfig.containsAccount(auditAccountName)) {
        const bucketName = new SsmParameter(this, 'SsmParamMacieBucketName', {
          region: cdk.Stack.of(this).region as Region,
          partition: cdk.Stack.of(this).partition,
          parameter: {
            name: '/accelerator/organization/security/macie/discovery-repository/bucket-name',
            accountId: auditAccountId,
            roleName: `AWSAccelerator-MacieSsmParam-${cdk.Stack.of(this).region}`,
          },
          invokingAccountID: cdk.Stack.of(this).account,
        }).value;

        const bucketKmsKeyArn = new SsmParameter(this, 'SsmParamMacieBucketKmsKeyArn', {
          region: cdk.Stack.of(this).region as Region,
          partition: cdk.Stack.of(this).partition,
          parameter: {
            name: '/accelerator/organization/security/macie/discovery-repository/bucket-kms-key-arn',
            accountId: auditAccountId,
            roleName: `AWSAccelerator-MacieSsmParam-${cdk.Stack.of(this).region}`,
          },
          invokingAccountID: cdk.Stack.of(this).account,
        }).value;
        new MacieExportConfigClassification(this, 'AwsMacieUpdateExportConfigClassification', {
          region: cdk.Stack.of(this).region,
          bucketName: bucketName,
          keyPrefix: `${cdk.Stack.of(this).account}-aws-macie-export-config`,
          kmsKeyArn: bucketKmsKeyArn,
        });
      } else {
        throw new Error(`Macie audit delegated admin account name "${auditAccountName}" not found.`);
      }
    }

    //
    // GuardDuty configuration
    //
    if (
      props.securityConfig.centralSecurityServices.guardduty.enable &&
      props.securityConfig.centralSecurityServices.guardduty.excludeRegions!.indexOf(
        cdk.Stack.of(this).region as Region,
      ) === -1
    ) {
      if (props.accountsConfig.containsAccount(auditAccountName)) {
        const bucketArn = new SsmParameter(this, 'SsmParamGuardDutyBucketName', {
          region: cdk.Stack.of(this).region as Region,
          partition: cdk.Stack.of(this).partition,
          parameter: {
            name: '/accelerator/organization/security/guardduty/publishing-destination/bucket-arn',
            accountId: auditAccountId,
            roleName: `AWSAccelerator-GuardDutySsmParam-${cdk.Stack.of(this).region}`,
          },
          invokingAccountID: cdk.Stack.of(this).account,
        }).value;

        const bucketKmsKeyArn = new SsmParameter(this, 'SsmParamGuardDutyBucketKmsKeyArn', {
          region: cdk.Stack.of(this).region as Region,
          partition: cdk.Stack.of(this).partition,
          parameter: {
            name: '/accelerator/organization/security/guardduty/publishing-destination/bucket-kms-key-arn',
            accountId: auditAccountId,
            roleName: `AWSAccelerator-GuardDutySsmParam-${cdk.Stack.of(this).region}`,
          },
          invokingAccountID: cdk.Stack.of(this).account,
        }).value;

        new GuardDutyPublishingDestination(this, 'GuardDutyPublishingDestination', {
          region: cdk.Stack.of(this).region,
          bucketArn: bucketArn,
          kmsKeyArn: bucketKmsKeyArn,
          exportDestinationType:
            props.securityConfig.centralSecurityServices.guardduty.exportConfiguration.destinationType,
        });
      } else {
        throw new Error(`Guardduty audit delegated admin account name "${auditAccountName}" not found.`);
      }
    }

    //
    // SecurityHub configuration
    //
    if (
      props.securityConfig.centralSecurityServices.securityHub.enable &&
      props.securityConfig.centralSecurityServices.securityHub.excludeRegions!.indexOf(
        cdk.Stack.of(this).region as Region,
      ) === -1
    ) {
      if (props.accountsConfig.containsAccount(auditAccountName)) {
        new SecurityHubStandards(this, 'SecurityHubStandards', {
          region: cdk.Stack.of(this).region,
          standards: props.securityConfig.centralSecurityServices.securityHub.standards,
        });
      } else {
        throw new Error(`SecurityHub audit delegated admin account name "${auditAccountName}" not found.`);
      }
    }

    //
    // AWS Config - Set up recorder and delivery channel, only if Control Tower
    // is not being used. Else the Control Tower SCP will block these calls from
    // member accounts
    //
    // If Control Tower is enabled, make sure to set up AWS Config in the
    // management account since this is not enabled by default by Control Tower.
    //
    // An AWS Control Tower preventive guardrail is enforced with AWS
    // Organizations using Service Control Policies (SCPs) that disallows
    // configuration changes to AWS Config.
    //
    let configRecorder: config.CfnConfigurationRecorder | undefined = undefined;
    if (
      !props.globalConfig.controlTower.enable ||
      props.accountsConfig.getManagementAccountId() === cdk.Stack.of(this).account
    ) {
      if (props.securityConfig.awsConfig.enableConfigurationRecorder) {
        const configRecorderRole = new iam.Role(this, 'ConfigRecorderRole', {
          assumedBy: new iam.ServicePrincipal('config.amazonaws.com'),
          managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSConfigRole')],
        });

        /**
         * As per the documentation, the config role should have
         * the s3:PutObject permission to avoid access denied issues
         * while AWS config tries to check the s3 bucket (in another account) write permissions
         * https://docs.aws.amazon.com/config/latest/developerguide/s3-bucket-policy.html
         *
         */
        configRecorderRole.addToPrincipalPolicy(
          new iam.PolicyStatement({
            actions: ['s3:PutObject'],
            resources: ['*'],
          }),
        );

        configRecorder = new config.CfnConfigurationRecorder(this, 'ConfigRecorder', {
          roleArn: configRecorderRole.roleArn,
          recordingGroup: {
            allSupported: true,
            includeGlobalResourceTypes: true,
          },
        });
      }

      if (props.securityConfig.awsConfig.enableDeliveryChannel) {
        new config.CfnDeliveryChannel(this, 'ConfigDeliveryChannel', {
          s3BucketName: `aws-accelerator-central-logs-${props.accountsConfig.getLogArchiveAccountId()}-${
            props.globalConfig.homeRegion
          }`,
          configSnapshotDeliveryProperties: {
            deliveryFrequency: 'One_Hour',
          },
        });
      }
    }

    //
    // Config Rules
    //
    Logger.info('[security-stack] Evaluating AWS Config rule sets');
    for (const ruleSet of props.securityConfig.awsConfig.ruleSets) {
      if (!this.isIncluded(ruleSet.deploymentTargets)) {
        Logger.info('[security-stack] Item excluded');
        continue;
      }

      Logger.info(
        `[security-stack] Account (${cdk.Stack.of(this).account}) should be included, deploying AWS Config Rules`,
      );

      for (const rule of ruleSet.rules) {
        Logger.info(`[security-stack] Creating managed rule ${rule.name}`);

        const resourceTypes: config.ResourceType[] = [];
        for (const resourceType of rule.complianceResourceTypes ?? []) {
          resourceTypes.push(config.ResourceType.of(resourceType));
        }

        const configRule = new config.ManagedRule(this, pascalCase(rule.name), {
          configRuleName: rule.name,
          identifier: rule.identifier,
          inputParameters: rule.inputParameters,
          ruleScope: {
            resourceTypes,
          },
        });

        if (configRecorder) {
          configRule.node.addDependency(configRecorder);
        }
      }
    }

    //
    // Custom Config Rules
    //
    Logger.info('[security-stack] Evaluating Custom AWS Config rule sets');
    for (const ruleSet of props.securityConfig.awsConfig.customRuleSets ?? []) {
      if (!this.isIncluded(ruleSet.deploymentTargets)) {
        Logger.info('[security-stack] Item excluded');
        continue;
      }

      Logger.info(
        `[security-stack] Account (${
          cdk.Stack.of(this).account
        }) should be included, deploying Custom AWS Custom Config Rules`,
      );

      for (const rule of ruleSet.rules) {
        Logger.info(`[security-stack] Creating custom config rule ${rule.name}`);
        let ruleScope: config.RuleScope | undefined;

        if (rule.triggeringResources.lookupType == 'ResourceTypes') {
          for (const item of rule.triggeringResources.lookupValue) {
            ruleScope = config.RuleScope.fromResources([config.ResourceType.of(item)]);
          }
        }

        if (rule.triggeringResources.lookupType == 'ResourceId') {
          ruleScope = config.RuleScope.fromResource(
            config.ResourceType.of(rule.triggeringResources.lookupKey),
            rule.triggeringResources.lookupValue[0],
          );
        }

        if (rule.triggeringResources.lookupType == 'Tag') {
          ruleScope = config.RuleScope.fromTag(
            rule.triggeringResources.lookupKey,
            rule.triggeringResources.lookupValue[0],
          );
        }

        /**
         * Lambda function for config custom role
         * Single lambda function can not be used for multiple config custom role, there is a pending issue with CDK team on this
         * https://github.com/aws/aws-cdk/issues/17582
         */
        const roleName = pascalCase(rule.name).split('_').join('-');
        const lambdaFunction = new cdk.aws_lambda.Function(this, pascalCase(rule.name) + '-Function', {
          runtime: new cdk.aws_lambda.Runtime(rule.lambda.runtime),
          handler: rule.lambda.handler,
          code: cdk.aws_lambda.Code.fromAsset(path.join(props.configDirPath, rule.lambda.sourceFilePath)),
          description: `AWS Config custom rule function used for "${rule.name}" rule`,
        });

        // Read in the policy document which should be properly formatted json
        const policyDocument = require(path.join(props.configDirPath, rule.lambda.rolePolicyFile));

        // Create a statements list using the PolicyStatement factory
        const policyStatements: cdk.aws_iam.PolicyStatement[] = [];
        for (const statement of policyDocument.Statement) {
          policyStatements.push(cdk.aws_iam.PolicyStatement.fromJson(statement));
        }

        policyStatements.forEach(policyStatement => {
          lambdaFunction?.addToRolePolicy(policyStatement);
        });

        new config.CustomRule(this, roleName + '-CustomRule', {
          configRuleName: roleName,
          lambdaFunction: lambdaFunction,
          periodic: rule.periodic,
          inputParameters: rule.lambda.inputParameters,
          description: `${rule.description}`,
          maximumExecutionFrequency:
            rule.maximumExecutionFrequency === undefined
              ? cdk.aws_config.MaximumExecutionFrequency.SIX_HOURS
              : (rule.maximumExecutionFrequency as cdk.aws_config.MaximumExecutionFrequency),
          ruleScope: ruleScope,
          configurationChanges: rule.configurationChanges,
        });
      }
    }

    //
    // Update IAM Password Policy
    //
    if (props.globalConfig.homeRegion === cdk.Stack.of(this).region) {
      Logger.info(`[security-stack] Setting the IAM Password policy`);
      new PasswordPolicy(this, 'IamPasswordPolicy', {
        ...props.securityConfig.iamPasswordPolicy,
      });
    }

    //
    // CloudWatch Metrics
    //
    for (const metricSetItem of props.securityConfig.cloudWatch.metricSets ?? []) {
      if (!metricSetItem.regions?.includes(cdk.Stack.of(this).region)) {
        Logger.info(`[security-stack] Current region not explicity specified for metric item, skip`);
        continue;
      }

      if (!this.isIncluded(metricSetItem.deploymentTargets)) {
        Logger.info(`[security-stack] Item excluded`);
        continue;
      }

      for (const metricItem of metricSetItem.metrics ?? []) {
        Logger.info(`[security-stack] Creating CloudWatch metric filter ${metricItem.filterName}`);

        new cdk.aws_logs.MetricFilter(this, pascalCase(metricItem.filterName), {
          logGroup: cdk.aws_logs.LogGroup.fromLogGroupName(
            this,
            `${pascalCase(metricItem.filterName)}_${pascalCase(metricItem.logGroupName)}`,
            metricItem.logGroupName,
          ),
          metricNamespace: metricItem.metricNamespace,
          metricName: metricItem.metricName,
          filterPattern: cdk.aws_logs.FilterPattern.literal(metricItem.filterPattern),
          metricValue: metricItem.metricValue,
        });
      }
    }

    //
    // CloudWatch Alarms
    //
    for (const alarmSetItem of props.securityConfig.cloudWatch.alarmSets ?? []) {
      if (!alarmSetItem.regions?.includes(cdk.Stack.of(this).region)) {
        Logger.info(`[security-stack] Current region not explicity specified for alarm item, skip`);
        continue;
      }

      if (!this.isIncluded(alarmSetItem.deploymentTargets)) {
        Logger.info(`[security-stack] Item excluded`);
        continue;
      }

      for (const alarmItem of alarmSetItem.alarms ?? []) {
        Logger.info(`[security-stack] Creating CloudWatch alarm ${alarmItem.alarmName}`);

        const alarm = new cdk.aws_cloudwatch.Alarm(this, pascalCase(alarmItem.alarmName), {
          alarmName: alarmItem.alarmName,
          alarmDescription: alarmItem.alarmDescription,
          metric: new cdk.aws_cloudwatch.Metric({
            metricName: alarmItem.metricName,
            namespace: alarmItem.namespace,
            period: cdk.Duration.seconds(alarmItem.period),
            statistic: alarmItem.statistic,
          }),
          comparisonOperator: this.getComparisonOperator(alarmItem.comparisonOperator),
          evaluationPeriods: alarmItem.evaluationPeriods,
          threshold: alarmItem.threshold,
          treatMissingData: this.getTreatMissingData(alarmItem.treatMissingData),
        });

        alarm.addAlarmAction(
          new cdk.aws_cloudwatch_actions.SnsAction(
            cdk.aws_sns.Topic.fromTopicArn(
              this,
              `${pascalCase(alarmItem.alarmName)}Topic`,
              cdk.Stack.of(this).formatArn({
                service: 'sns',
                region: cdk.Stack.of(this).region,
                account: props.accountsConfig.getAuditAccountId(),
                resource: `aws-accelerator-${alarmItem.snsAlertLevel}Notifications`,
                arnFormat: cdk.ArnFormat.NO_RESOURCE_NAME,
              }),
            ),
          ),
        );
      }
    }
  }

  private getComparisonOperator(comparisonOperator: string): cdk.aws_cloudwatch.ComparisonOperator {
    if (comparisonOperator === 'GreaterThanOrEqualToThreshold') {
      return cdk.aws_cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD;
    }
    if (comparisonOperator === 'GreaterThanThreshold') {
      return cdk.aws_cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD;
    }
    if (comparisonOperator === 'LessThanThreshold') {
      return cdk.aws_cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD;
    }
    if (comparisonOperator === 'LessThanOrEqualToThreshold') {
      return cdk.aws_cloudwatch.ComparisonOperator.LESS_THAN_OR_EQUAL_TO_THRESHOLD;
    }
    if (comparisonOperator === 'LessThanLowerOrGreaterThanUpperThreshold') {
      return cdk.aws_cloudwatch.ComparisonOperator.LESS_THAN_LOWER_OR_GREATER_THAN_UPPER_THRESHOLD;
    }
    if (comparisonOperator === 'GreaterThanUpperThreshold') {
      return cdk.aws_cloudwatch.ComparisonOperator.GREATER_THAN_UPPER_THRESHOLD;
    }
    if (comparisonOperator === 'LessThanLowerThreshold') {
      return cdk.aws_cloudwatch.ComparisonOperator.LESS_THAN_LOWER_THRESHOLD;
    }
    return cdk.aws_cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD;
  }

  private getTreatMissingData(treatMissingData: string): cdk.aws_cloudwatch.TreatMissingData {
    if (treatMissingData === 'breaching') {
      return cdk.aws_cloudwatch.TreatMissingData.BREACHING;
    }
    if (treatMissingData === 'notBreaching') {
      return cdk.aws_cloudwatch.TreatMissingData.NOT_BREACHING;
    }
    if (treatMissingData === 'ignore') {
      return cdk.aws_cloudwatch.TreatMissingData.IGNORE;
    }
    if (treatMissingData === 'missing') {
      return cdk.aws_cloudwatch.TreatMissingData.MISSING;
    }
    return cdk.aws_cloudwatch.TreatMissingData.NOT_BREACHING;
  }
}
