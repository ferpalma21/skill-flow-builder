/* 
 * Copyright 2018 Amazon.com, Inc. and its affiliates. All Rights Reserved.
 *
 * SPDX-License-Identifier: LicenseRef-.amazon.com.-AmznSL-1.0
 *
 * Licensed under the Amazon Software License (the "License").
 * You may not use this file except in compliance with the License.
 * A copy of the License is located at
 *
 *   http://aws.amazon.com/asl/
 *
 * or in the "license" file accompanying this file. This file is distributed
 * on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either
 * express or implied. See the License for the specific language governing
 * permissions and limitations under the License.
 */

import childProcess from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import * as sinon from 'sinon';
import { strict as assert } from 'assert';
import mockFileSystem from 'mock-fs';

import { StageCommand } from '../lib/stageCommand';
import { ConsoleLogger } from '../lib/consoleLogger';
import { ConsoleStdOutput } from '../lib/consoleStdOutput';

import {
  STORY_DIR,
  ASK_PROFILE_NAME,
  ASK_SKILL_DIRECTORY_NAME,
  DUMMY_SFB_ROOT,

  ASK_SKILL_DIRECTORY_PATH,
  BUILD_ARTIFACT_PATH,
  STAGED_SKILL_JSON_PATH,

  STORED_METADATA_PATH,
  STORED_SKILL_JSON_PATH,

  DUMMY_ASK_FILE_SYSTEM,

  createMockSpawn,
  createMockChildProcess,
  stubSfbCliRoot,
  readTextFile,
  assertCalledManyTimesWithArgs,
} from './testUtilities';

describe('alexa-sfb stage', () => {
  let dummyFileSystem: any;
  let stubbedSfbCliRoot: any;
  let mockSpawn: any;
  let mockedAskNewChild: any;
  let stageCommand: StageCommand; // Subject under test

  const SAMPLE_CLOUDFORMATION_TEMPLATE = `---
dummy: CloudFormation template
foo:
bar: foo-bar-SFB-STORY-ID-baz-quux
something:
  SFB-ENVIRONMENT-VARIABLES
`;
  const EXPECTED_CLOUDFORMATION_TEMPLATE = `---
dummy: CloudFormation template
foo:
bar: foo-bar-dummy-story-id-baz-quux
something:
        Environment:
        Variables:
          stage: dummy-stage

`;
  const DUMMY_SKILL_MANIFEST = {
    manifest: {
      apis: {
        custom: {},
      },
      publishingInformation: {
        locales: {
          'en-US': 'dummy en-US data',
        },
      },
    },
  };

  /**
   * Helper to re-mock file system after initial mocking
   */
  const reMockFileSystem = (fileSystem: any) => {
    // Need to restore and re-stub SFB CLI root (see function documentation)
    stubbedSfbCliRoot.restore();
    mockFileSystem.restore();

    mockFileSystem(fileSystem);
    stubSfbCliRoot();
  };

  /**
   * Helper to mock file system to a state after `BakeCommand` is done running.
   */
  const mockFileSystemToPostBakeState = () => {
    dummyFileSystem = JSON.parse(JSON.stringify(DUMMY_ASK_FILE_SYSTEM)); // Deep copy

    // Remove ASK skill directory (generated by `StageCommand`) from build artifact
    delete dummyFileSystem[STORY_DIR]['.deploy'][ASK_SKILL_DIRECTORY_NAME];

    // User-specific location for ffmpeg
    dummyFileSystem['/dummyBin'] = {
      bin: {
        ffmpeg: 'dummy ffmpeg',
      },
    };

    const abcConfig = JSON.parse(dummyFileSystem[STORY_DIR]['abcConfig.json']);
    dummyFileSystem[STORY_DIR]['abcConfig.json'] = JSON.stringify({
      default: {
        ...abcConfig.default,
        'ffmpeg-location-for-skill': '/dummyBin/bin/ffmpeg',
      },
      'dummy-stage-en-gb': {
        ...abcConfig.default,
        'story-id': 'dummy-story-id',
      },
    });

    // Assume that skill has never been deployed before, so it has no metadata
    dummyFileSystem[STORY_DIR].metadata['dummy-stage-en-GB'] = {};

    // `BakeCommand` compiles TS code in `code` into `code/dist`
    dummyFileSystem[STORY_DIR].code.dist = {
      'index.js': '// Dummy index.js compiled during import command',
    };
    dummyFileSystem[STORY_DIR].code['package.json'] = JSON.stringify({
      dependencies: {
        dummy: 'dependency',
        localDependency: 'file:../foo/bar',
      },
      devDependencies: { another: 'dependency' },
    });

    // `BakeCommand` copies abcConfig into the build artifact directory
    dummyFileSystem[STORY_DIR]['.deploy'].dist.abcConfig = {
      'abcConfig.json': 'dummy baked abcConfig',
    };
    // `BakeCommand` computes interaction models into the build artifact directory
    dummyFileSystem[STORY_DIR]['.deploy'].dist.res = {
      'en-US': {
        'en-US.json': 'dummy baked en-US interaction model',
      },
      'en-GB': {
        'en-GB.json': 'dummy baked en-GB interaction model',
      },
      'en-CA': {
        'en-CA.json': 'dummy baked en-CA interaction model',
      },
    };

    // Sample CloudFormation template in the SFB CLI installation location
    dummyFileSystem[DUMMY_SFB_ROOT] = {
      'skill-stack.yaml': SAMPLE_CLOUDFORMATION_TEMPLATE,
    };

    mockFileSystem(dummyFileSystem);
    stubbedSfbCliRoot = stubSfbCliRoot();
  };

  /**
   * Helper to mock file system to a state after `ask new` command is run
   * (i.e., generates the ASK skill directory)
   */
  const mockFileSystemToPostAskNewCommand = () => {
    dummyFileSystem[STORY_DIR]['.deploy'][ASK_SKILL_DIRECTORY_NAME] =
      JSON.parse(JSON.stringify(DUMMY_ASK_FILE_SYSTEM[STORY_DIR]['.deploy'][ASK_SKILL_DIRECTORY_NAME]));

    dummyFileSystem[STORY_DIR]['.deploy'][ASK_SKILL_DIRECTORY_NAME]['skill-package']['skill.json'] =
      JSON.stringify(DUMMY_SKILL_MANIFEST);

    // Specifically prevent the CloudFormation file change from being obliterated
    const cfnTemplate = `${STORED_METADATA_PATH}/dummy-stage-en-GB/skill-stack.yaml`;
    if (fs.existsSync(cfnTemplate)) {
      dummyFileSystem[STORY_DIR].metadata['dummy-stage-en-GB']['skill-stack.yaml'] =
        readTextFile(cfnTemplate);
    }
    const cfnTemplateWithoutEnv = `${STORED_METADATA_PATH}/skill-stack.yaml`;
    if (fs.existsSync(cfnTemplateWithoutEnv)) {
      dummyFileSystem[STORY_DIR].metadata['skill-stack.yaml'] =
        readTextFile(cfnTemplateWithoutEnv);
    }

    reMockFileSystem(dummyFileSystem);
  };

  beforeEach(() => {
    mockFileSystemToPostBakeState();

    sinon.stub(process, 'env').value({ stage: 'dummy-stage', locale: 'en-GB' });

    mockSpawn = createMockSpawn();

    mockSpawn.withArgs('ask', ['--version']).returns(createMockChildProcess(['2.7.1']));

    // Force `rm -rf` to actually remove files in our mock file system
    mockSpawn.withArgs('rm', ['-rf', `"${ASK_SKILL_DIRECTORY_PATH}/lambda"`]).callsFake(() => {
      delete dummyFileSystem[STORY_DIR]['.deploy'][ASK_SKILL_DIRECTORY_NAME].lambda;
      reMockFileSystem(dummyFileSystem);
      return createMockChildProcess();
    });

    // ask new command outputs an interactive prompt, so we mimic that
    mockedAskNewChild = createMockChildProcess([
      'Dummy interactive prompt 1',
      'Dummy interactive prompt 2',
      'Dummy interactive prompt 3',
    ]);
    mockSpawn.withArgs(
      'ask',
      ['new', sinon.match.any, sinon.match.any, sinon.match.any, sinon.match.any, sinon.match.any, sinon.match.any],
    ).callsFake(() => {
      mockFileSystemToPostAskNewCommand();
      return mockedAskNewChild;
    });

    stageCommand = new StageCommand(
      STORY_DIR,
      'cfn',
      new ConsoleLogger(true),
      new ConsoleStdOutput(),
    );
  });

  afterEach(() => {
    mockFileSystem.restore();
    mockSpawn.restore();
    sinon.restore();
  });

  /**
   * Shared example
   */
  const itStagesSuccessfully = (metadataDir: string) => {
    it('executes appropriate shell commands', async () => {
      await stageCommand.run();

      assertCalledManyTimesWithArgs(mockSpawn, [
        ['ask', [ '--version' ], { shell: true, cwd: BUILD_ARTIFACT_PATH }],
        [
          'ask',
          [
            'new',
            '--profile',
            ASK_PROFILE_NAME,
            '--template-url',
            'https://github.com/alexa/skill-sample-nodejs-hello-world.git',
            '--template-branch',
            'ask-cli-x',
          ],
          { shell: true, cwd: BUILD_ARTIFACT_PATH },
        ],
        ['rm', ['-rf', `"${ASK_SKILL_DIRECTORY_PATH}/lambda"`], { shell: true }],
        ['npm', ['install', '--production'], { shell: true, cwd: `${ASK_SKILL_DIRECTORY_PATH}/lambda` }],
      ]);
    });

    it('auto-responds correctly to ASK CLI prompts', async () => {
      await stageCommand.run();

      // Wait for interactive prompts to complete
      await new Promise((resolve) => setTimeout(resolve, 1500));

      assertCalledManyTimesWithArgs(mockedAskNewChild.stdin.write, [
        ['2\n'],
        ['dummy-ask-directory\n'],
        ['dummy-ask-directory\n'],
      ]);
    });

    it('stores CloudFormation template into project directory', async () => {
      await stageCommand.run();

      assert.equal(
        readTextFile(`${metadataDir}/skill-stack.yaml`),
        EXPECTED_CLOUDFORMATION_TEMPLATE,
      );
    });

    it('stages miscellaneous baked resources', async () => {
      await stageCommand.run();

      assert.equal(
        readTextFile(`${BUILD_ARTIFACT_PATH}/dist/abcConfig/abcConfig.json`),
        'dummy baked abcConfig',
      );
      assert.equal(
        readTextFile(`${BUILD_ARTIFACT_PATH}/dist/res/en-US/en-US.json`),
        'dummy baked en-US interaction model',
      );
    });

    it('stages compiled JavaScript code', async () => {
      await stageCommand.run();

      assert.equal(
        readTextFile(`${ASK_SKILL_DIRECTORY_PATH}/lambda/index.js`),
        '// Dummy index.js compiled during import command',
      );
    });

    it('modifies package.json to remove dev dependencies and adjust local paths', async () => {
      await stageCommand.run();

      assert.deepEqual(
        JSON.parse(readTextFile(`${ASK_SKILL_DIRECTORY_PATH}/lambda/package.json`)),
        {
          dependencies: {
            dummy: 'dependency',
            localDependency: 'file:../../../foo/bar',
          },
        },
      );
    });

    it('stages ffmpeg', async () => {
      await stageCommand.run();

      assert.equal(
        readTextFile(`${ASK_SKILL_DIRECTORY_PATH}/lambda/ffmpeg`),
        'dummy ffmpeg',
      );
    });

    it('stages interaction models', async () => {
      await stageCommand.run();

      assert.equal(
        readTextFile(`${ASK_SKILL_DIRECTORY_PATH}/skill-package/interactionModels/custom/en-GB.json`),
        'dummy baked en-GB interaction model',
      );
      assert.equal(
        readTextFile(`${ASK_SKILL_DIRECTORY_PATH}/skill-package/interactionModels/custom/en-US.json`),
        'dummy baked en-US interaction model',
      );
    });

    it('does not stage interaction models excluded in abcConfig', async () => {
      await stageCommand.run();

      assert.ok(!fs.existsSync(`${ASK_SKILL_DIRECTORY_PATH}/skill-package/interactionModels/custom/en-CA.json`));
    });

    it('modifies package manifest file', async () => {
      await stageCommand.run();

      assert.deepEqual(
        JSON.parse(readTextFile(STAGED_SKILL_JSON_PATH)),
        {
          manifest: {
            apis: {
              // Force-adds interface for APL
              custom: { interfaces: [{ type: 'ALEXA_PRESENTATION_APL' }] },
            },
            publishingInformation: {
              // Auto-fills info for non-default locales
              locales: { 'en-US': 'dummy en-US data', 'en-GB': 'dummy en-US data' },
            },
          },
        },
      );
    });

    it('stores modified manifest file back into project directory', async () => {
      await stageCommand.run();

      assert.deepEqual(
        JSON.parse(readTextFile(`${metadataDir}/skill.json`)),
        JSON.parse(readTextFile(STAGED_SKILL_JSON_PATH)),
      );
    });
  };

  itStagesSuccessfully(`${STORED_METADATA_PATH}/dummy-stage-en-GB`);

  describe('without the stage environment variable', () => {
    beforeEach(() => {
      sinon.stub(process, 'env').value({ locale: 'dummy-stage-en-GB' });
    });

    itStagesSuccessfully(`${STORED_METADATA_PATH}/dummy-stage-en-GB`);
  });

  describe('without the locale environment variable', () => {
    beforeEach(() => {
      sinon.stub(process, 'env').value({ stage: 'dummy-stage-en-GB' });
    });

    itStagesSuccessfully(`${STORED_METADATA_PATH}/dummy-stage-en-GB`);
  });

  describe('with no environment variable', () => {
    beforeEach(() => {
      sinon.stub(process, 'env').value({ });

      const abcConfig = JSON.parse(dummyFileSystem[STORY_DIR]['abcConfig.json']);
      abcConfig.default['story-id'] = abcConfig['dummy-stage-en-gb']['story-id'];
      delete abcConfig['dummy-stage-en-gb'];

      // Assume that skill has never been deployed before, so it has no metadata
      dummyFileSystem[STORY_DIR].metadata = {};

      reMockFileSystem(dummyFileSystem);
    });

    itStagesSuccessfully(STORED_METADATA_PATH);
  });

  describe('when previously built with CloudFormation deployer', () => {
    beforeEach(() => {
      const manifest = JSON.parse(JSON.stringify(DUMMY_SKILL_MANIFEST));
      manifest.manifest.dummyKey = 'existing skill manifest';

      dummyFileSystem[STORY_DIR].metadata['dummy-stage-en-GB'] = {
        'skill.json': JSON.stringify(manifest),
        'skill-stack.yaml': 'bar',
      };

      reMockFileSystem(dummyFileSystem);
    });

    it('modifies pre-existing package manifest file', async () => {
      await stageCommand.run();

      assert.deepEqual(
        JSON.parse(readTextFile(STAGED_SKILL_JSON_PATH)),
        {
          manifest: {
            dummyKey: 'existing skill manifest',
            apis: {
              // Force-adds interface for APL
              custom: { interfaces: [{ type: 'ALEXA_PRESENTATION_APL' }] },
            },
            publishingInformation: {
              // Auto-fills info for non-default locales
              locales: { 'en-US': 'dummy en-US data', 'en-GB': 'dummy en-US data' },
            },
          },
        },
      );
    });
  });

  describe('when previously built with lambda deployer', () => {
    beforeEach(() => {
      dummyFileSystem[STORY_DIR].metadata['dummy-stage-en-GB'] = {
        'skill.json': JSON.stringify(DUMMY_SKILL_MANIFEST),
      };

      reMockFileSystem(dummyFileSystem);
    });

    it('throws', async () => {
      await assert.rejects(
        async () => await stageCommand.run(),
        /Invalid ASK deployer chosen/,
      );
    });
  });

  describe('when ASK skill directory already exists', () => {
    beforeEach(() => {
      mockFileSystemToPostAskNewCommand();
    });

    it('stores CloudFormation template into project directory', async () => {
      await stageCommand.run();

      assert.equal(
        readTextFile(`${STORED_METADATA_PATH}/dummy-stage-en-GB/skill-stack.yaml`),
        EXPECTED_CLOUDFORMATION_TEMPLATE,
      );
    });

    it('skips staging', async () => {
      await stageCommand.run();

      // ASK CLI calls are never made
      assertCalledManyTimesWithArgs(mockSpawn, [
        ['npm', ['install', '--production'], { shell: true, cwd: `${ASK_SKILL_DIRECTORY_PATH}/lambda` }],
      ]);
    });
  });

  describe('when deployer is unsupported', () => {
    it('throws', () => {
      assert.throws(() => {
        new StageCommand(
          STORY_DIR,
          'unsupported-deployer',
          new ConsoleLogger(true),
          new ConsoleStdOutput(),
        );
      }, /Invalid deployer/);
    });
  });

  describe('when deployer is lambda', () => {
    /**
     * Shared example
     */
    const itBehavesLikeLambdaDeployer = () => {
      it('skips storing CloudFormation template', async () => {
        await stageCommand.run();

        assert.ok(!fs.existsSync(`${STORED_METADATA_PATH}/dummy-stage-en-GB/skill-stack.yaml`));
      });

      it('tells ASK CLI to use lambda deployer', async () => {
        await stageCommand.run();

        // Wait for interactive prompts to complete
        await new Promise((resolve) => setTimeout(resolve, 1500));

        assertCalledManyTimesWithArgs(mockedAskNewChild.stdin.write, [
          ['3\n'],
          ['dummy-ask-directory\n'],
          ['dummy-ask-directory\n'],
        ]);
      });
    };

    beforeEach(() => {
      stageCommand = new StageCommand(
        STORY_DIR,
        'lambda',
        new ConsoleLogger(true),
        new ConsoleStdOutput(),
      );
    });

    itBehavesLikeLambdaDeployer();

    describe('when previously built with lambda deployer', () => {
      beforeEach(() => {
        dummyFileSystem[STORY_DIR].metadata['dummy-stage-en-GB'] = {
          'skill.json': JSON.stringify(DUMMY_SKILL_MANIFEST),
        };

        reMockFileSystem(dummyFileSystem);
      });

      itBehavesLikeLambdaDeployer();
    });

    describe('when previously built with CloudFormation deployer', () => {
      beforeEach(() => {
        dummyFileSystem[STORY_DIR].metadata['dummy-stage-en-GB'] = {
          'skill.json': JSON.stringify(DUMMY_SKILL_MANIFEST),
          'skill-stack.yaml': 'bar',
        };

        reMockFileSystem(dummyFileSystem);
      });

      it('throws', async () => {
        await assert.rejects(
          async () => await stageCommand.run(),
          /Invalid ASK deployer chosen/,
        );
      });
    });
  });

  describe('when ffmpeg location is not configured', () => {
    beforeEach(() => {
      const abcConfig = JSON.parse(dummyFileSystem[STORY_DIR]['abcConfig.json']);
      delete abcConfig.default['ffmpeg-location-for-skill'];
      dummyFileSystem[STORY_DIR]['abcConfig.json'] = JSON.stringify(abcConfig);

      dummyFileSystem[STORY_DIR].code.ffmpeg = 'project code ffmpeg';

      reMockFileSystem(dummyFileSystem);
    });

    it('uses ffmpeg from project code directory', async () => {
      await stageCommand.run();

      assert.equal(
        readTextFile(`${ASK_SKILL_DIRECTORY_PATH}/lambda/ffmpeg`),
        'project code ffmpeg',
      );
    });
  });

  describe('when configured to skip ffmpeg copy', () => {
    beforeEach(() => {
      const abcConfig = JSON.parse(dummyFileSystem[STORY_DIR]['abcConfig.json']);
      abcConfig.default.skipFFMPEGInclude = true;
      dummyFileSystem[STORY_DIR]['abcConfig.json'] = JSON.stringify(abcConfig);

      reMockFileSystem(dummyFileSystem);
    });

    it('skips ffmpeg copy', async () => {
      await stageCommand.run();

      assert.ok(!fs.existsSync(`${ASK_SKILL_DIRECTORY_PATH}/lambda/ffmpeg`));
    });
  });
});