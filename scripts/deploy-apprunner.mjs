// Deploys the commit on origin/main to AWS App Runner, the primary demo host.
// Pushing to main doesn't do this on its own: the service has automatic deployments off.
//
//   AWS_PROFILE=<profile> npm run deploy
//
// It refuses uncommitted changes or a commit that isn't on origin/main, so the demo always matches main.
// It builds an x86-64 image tagged with the short commit, pushes it to ECR if that tag isn't there yet,
// then points the service at it. Every other setting, including environment variables and secrets,
// is copied from the running service unchanged. The account ID is never printed.
import { execFileSync } from 'node:child_process';

const SERVICE = process.env.APPRUNNER_SERVICE ?? 'proof-before-pay';
const REGION = process.env.AWS_REGION ?? 'us-west-2';
const REPOSITORY = process.env.ECR_REPOSITORY ?? 'proof-before-pay';
const WAIT_MS = 15 * 60_000;

let account = '';
const mask = (text) => (account === '' ? text : text.replaceAll(account, '<account>'));

function run(cmd, args, options = {}) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...options }).trim();
  } catch (error) {
    throw new Error(mask(`${cmd} ${args.slice(0, 2).join(' ')} failed: ${String(error.stderr ?? error.message).trim()}`));
  }
}
const aws = (...args) => JSON.parse(run('aws', [...args, '--region', REGION, '--output', 'json']));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (run('git', ['status', '--porcelain']) !== '') throw new Error('uncommitted changes; commit them and push first');
run('git', ['fetch', '--quiet', 'origin', 'main']);
const head = run('git', ['rev-parse', 'HEAD']);
if (head !== run('git', ['rev-parse', 'origin/main'])) throw new Error('HEAD is not origin/main; push first');
const tag = head.slice(0, 7);

account = aws('sts', 'get-caller-identity').Account;
const registry = `${account}.dkr.ecr.${REGION}.amazonaws.com`;
const image = `${registry}/${REPOSITORY}:${tag}`;
const shown = `<registry>/${REPOSITORY}:${tag}`;

const tagged = JSON.parse(run('aws', ['ecr', 'list-images', '--repository-name', REPOSITORY, '--filter', 'tagStatus=TAGGED', '--region', REGION, '--output', 'json']));
if (tagged.imageIds.some((id) => id.imageTag === tag)) {
  console.log(`${shown} is already in ECR`);
} else {
  console.log(`building ${shown}`);
  run('docker', ['build', '--platform', 'linux/amd64', '-t', image, '.'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const password = run('aws', ['ecr', 'get-login-password', '--region', REGION]);
  run('docker', ['login', '--username', 'AWS', '--password-stdin', registry], { input: password });
  run('docker', ['push', image]);
  console.log(`pushed ${shown}`);
}

const summary = aws('apprunner', 'list-services').ServiceSummaryList.find((s) => s.ServiceName === SERVICE);
if (summary === undefined) throw new Error(`no App Runner service named ${SERVICE} in ${REGION}`);
const service = aws('apprunner', 'describe-service', '--service-arn', summary.ServiceArn).Service;
const source = service.SourceConfiguration;
if (service.Status !== 'RUNNING') throw new Error(`service is ${service.Status}, not RUNNING`);

if (source.ImageRepository.ImageIdentifier === image) {
  console.log(`service already runs ${shown}`);
} else {
  const next = {
    AuthenticationConfiguration: source.AuthenticationConfiguration,
    AutoDeploymentsEnabled: source.AutoDeploymentsEnabled,
    ImageRepository: { ...source.ImageRepository, ImageIdentifier: image },
  };
  aws('apprunner', 'update-service', '--service-arn', summary.ServiceArn, '--source-configuration', JSON.stringify(next));
  console.log(`deploying ${shown}`);
  const started = Date.now();
  let status = 'OPERATION_IN_PROGRESS';
  while (status === 'OPERATION_IN_PROGRESS') {
    if (Date.now() - started > WAIT_MS) throw new Error('deployment still in progress after 15 minutes');
    await wait(5000);
    status = aws('apprunner', 'describe-service', '--service-arn', summary.ServiceArn).Service.Status;
  }
  const last = aws('apprunner', 'list-operations', '--service-arn', summary.ServiceArn, '--max-results', '1').OperationSummaryList[0];
  if (status !== 'RUNNING' || last?.Status !== 'SUCCEEDED') throw new Error(`deployment ended ${status}, operation ${last?.Status}`);
  console.log(`deployed in ${Math.round((Date.now() - started) / 1000)} s`);
}

const url = `https://${service.ServiceUrl}`;
const health = await fetch(`${url}/healthz`);
if (!health.ok) throw new Error(`${url}/healthz answered ${health.status}`);
console.log(`${url} healthy: ${JSON.stringify(await health.json())}`);
console.log(`next: node scripts/check-ui.mjs ${url}`);
