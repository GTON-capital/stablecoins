const {expect} = require("chai");
const {ethers} = require("hardhat");
const {
    prepareWrappedSSLP, CASE_WRAPPED_TO_UNDERLYING_WRAPPED_LP_TOKEN,
    CASE_KEYDONIX_WRAPPED_TO_UNDERLYING_WRAPPED_LP_TOKEN
} = require("../helpers/deploy");
const {directBonesReward, lockedBonesReward, fullBonesReward} = require("./helpers/TopDogLogic");
const {deployContract} = require("../helpers/ethersUtils");
const {PARAM_FORCE_MOVE_WRAPPED_ASSET_POSITION_ON_LIQUIDATION} = require("../../lib/constants");
const {cdpManagerWrapper} = require("../helpers/cdpManagerWrappers");

ether = ethers.utils.parseUnits;

const EPSILON = ethers.BigNumber.from('20000000');

const oracleCases = [
    [CASE_WRAPPED_TO_UNDERLYING_WRAPPED_LP_TOKEN, 'cdp manager'],
    [CASE_KEYDONIX_WRAPPED_TO_UNDERLYING_WRAPPED_LP_TOKEN, 'cdp manager keydonix'],
]

let context = {};
describe("WrappedShibaSwapLp", function () {

    beforeEach(async function () {
        await network.provider.send("evm_setAutomine", [true]);

        [context.deployer, context.user1, context.user2, context.user3, context.manager, context.bonesFeeReceiver] = await ethers.getSigners();
    });

    describe("Oracles independent tests", function () {
        beforeEach(async function () {
            await prepareWrappedSSLP(context, CASE_WRAPPED_TO_UNDERLYING_WRAPPED_LP_TOKEN);

            // initials distribution of lptokens to users
            await context.sslpToken0.transfer(context.user1.address, ether('1'));
            await context.sslpToken0.transfer(context.user2.address, ether('1'));
            await context.sslpToken0.transfer(context.user3.address, ether('1'));
        })

        describe("constructor", function () {
            it("wrapped token name and symbol", async function () {
                expect(await context.wrappedSslp0.symbol()).to.be.equal("wuSSLP0tokenAtokenB"); // topdog pool 0 with sslpToken0 (tokenA, tokenB)
                expect(await context.wrappedSslp0.name()).to.be.equal("Wrapped by Unit SushiSwap LP0 tokenA-tokenB"); // topdog pool 1 with sslpToken1 (tokenC, tokenD)
                expect(await context.wrappedSslp0.decimals()).to.be.equal(await context.sslpToken0.decimals());

                expect(await context.wrappedSslp1.symbol()).to.be.equal("wuSSLP1tokenCtokenD"); // topdog pool 1 with sslpToken1 (tokenC, tokenD)
                expect(await context.wrappedSslp1.name()).to.be.equal("Wrapped by Unit SushiSwap LP1 tokenC-tokenD"); // topdog pool 1 with sslpToken1 (tokenC, tokenD)
                expect(await context.wrappedSslp1.decimals()).to.be.equal(await context.sslpToken1.decimals());
            });
        });

        describe("pool direct deposit/withdraw", function () {
            it("prohibited deposit for another user", async function () {
                const lockAmount = ether('0.4');
                await prepareUserForJoin(context.user1, ether('1'));

                await expect(
                    context.wrappedSslp0.connect(context.user1).deposit(context.user2.address, lockAmount)
                ).to.be.revertedWith("AUTH_FAILED");
            });

            it("not approved sslp token", async function () {
                const lockAmount = ether('0.4');
                await expect(
                    context.wrappedSslp0.connect(context.user1).deposit(context.user1.address, lockAmount)
                ).to.be.revertedWith("TRANSFER_FROM_FAILED");
            });

            it("zero deposit", async function () {
                await context.wrappedSslp0.connect(context.user1).deposit(context.user1.address, 0);
                expect(await context.sslpToken0.balanceOf(context.user1.address)).to.be.equal(ether('1'));
                expect(await context.wrappedSslp0.balanceOf(context.user1.address)).to.be.equal(0);

                await context.wrappedSslp0.connect(context.user1).deposit(context.user1.address, 0);
                expect(await context.sslpToken0.balanceOf(context.user1.address)).to.be.equal(ether('1'));
                expect(await context.wrappedSslp0.balanceOf(context.user1.address)).to.be.equal(0);
            });

            it("zero deposit as claim reward", async function () {
                const lockAmount = ether('0.4');
                await prepareUserForJoin(context.user1, ether('1'));

                await context.wrappedSslp0.connect(context.user1).deposit(context.user1.address, lockAmount);
                expect(await bonesBalance(context.user1)).to.be.equal(0);

                await context.wrappedSslp0.connect(context.user1).deposit(context.user1.address, 0);
                expect(await bonesBalance(context.user1)).not.to.be.equal(0);
            });

            it("transfer sslp token", async function () {
                const lockAmount = ether('0.4');
                await prepareUserForJoin(context.user1, ether('1'));
                await prepareUserForJoin(context.user2, ether('1'));

                await context.wrappedSslp0.connect(context.user1).deposit(context.user1.address, lockAmount);
                await context.wrappedSslp0.connect(context.user2).deposit(context.user2.address, lockAmount);

                // user cannot transfer tokens
                await expect(
                    context.wrappedSslp0.connect(context.user1).transfer(context.user3.address, lockAmount)
                ).to.be.revertedWith("AUTH_FAILED");

                // another user cannot transfer tokens
                await expect(
                    context.wrappedSslp0.connect(context.user2).transfer(context.user3.address, lockAmount)
                ).to.be.revertedWith("AUTH_FAILED");
            });


            it("transfer from for sslp token", async function () {
                const lockAmount = ether('0.4');
                await prepareUserForJoin(context.user1, ether('1'));

                await context.wrappedSslp0.connect(context.user1).deposit(context.user1.address, lockAmount);

                // user cannot transfer tokens from another
                await expect(
                    context.wrappedSslp0.connect(context.user2).transferFrom(context.user1.address, context.user3.address, lockAmount)
                ).to.be.revertedWith("AUTH_FAILED");

                // even if they are approved
                await context.usdp.connect(context.user1).approve(context.user2.address, lockAmount);
                await expect(
                    context.wrappedSslp0.connect(context.user2).transferFrom(context.user1.address, context.user3.address, lockAmount)
                ).to.be.revertedWith("AUTH_FAILED");

                // transfer allowance for vault tested in liquidation cases
            });
        });

        describe("reward distribution cases", function () {
            it('consecutive deposit and withdrawal with 3 users', async function () {
                const lockAmount = ether('0.4');
                const usdpAmount = ether('0.2');

                await prepareUserForJoin(context.user1, lockAmount);
                await prepareUserForJoin(context.user2, lockAmount);
                await prepareUserForJoin(context.user3, lockAmount);

                const {blockNumber: deposit1Block} = await wrapAndJoin(context.user1, lockAmount, usdpAmount);
                expect(await context.sslpToken0.balanceOf(context.user1.address)).to.be.equal(ether('0.6'), "transferred from user");
                const {blockNumber: deposit2Block} = await wrapAndJoin(context.user2, lockAmount, usdpAmount);
                expect(await context.sslpToken0.balanceOf(context.user2.address)).to.be.equal(ether('0.6'), "transferred from user");
                const {blockNumber: deposit3Block} = await wrapAndJoin(context.user3, lockAmount, usdpAmount);
                expect(await context.sslpToken0.balanceOf(context.user3.address)).to.be.equal(ether('0.6'), "transferred from user");

                expect(await context.sslpToken0.balanceOf(context.topDog.address)).to.be.equal(lockAmount.mul(3), "transferred to TopDog");
                expect(await context.wrappedSslp0.balanceOf(context.vault.address)).to.be.equal(lockAmount.mul(3), "wrapped token sent to vault");
                expect(await context.wrappedSslp0.totalSupply()).to.be.equal(lockAmount.mul(3), "minted only wrapped tokens for deposited amount");

                const {blockNumber: withdrawal1Block} = await unwrapAndExit(context.user1, lockAmount, usdpAmount);
                expect(await context.sslpToken0.balanceOf(context.user1.address)).to.be.equal(ether('1'), "returned asset");
                const {blockNumber: withdrawal2Block} = await unwrapAndExit(context.user2, lockAmount, usdpAmount);
                expect(await context.sslpToken0.balanceOf(context.user1.address)).to.be.equal(ether('1'), "returned asset");
                const {blockNumber: withdrawal3Block} = await unwrapAndExit(context.user3, lockAmount, usdpAmount);
                expect(await context.sslpToken0.balanceOf(context.user1.address)).to.be.equal(ether('1'), "returned asset");

                // with 3 simultaneous users we have imprecise calculations
                const user1Reward = directBonesReward(deposit1Block, deposit2Block)
                    .add(directBonesReward(deposit2Block, deposit3Block).div(2))
                    .add(directBonesReward(deposit3Block, withdrawal1Block).div(3));
                expect(await bonesBalance(context.user1)).to.be.closeTo(user1Reward, EPSILON);

                const user2Reward = directBonesReward(deposit2Block, deposit3Block).div(2)
                    .add(directBonesReward(deposit3Block, withdrawal1Block).div(3))
                    .add(directBonesReward(withdrawal1Block, withdrawal2Block).div(2));
                expect(await bonesBalance(context.user2)).to.be.closeTo(user2Reward, EPSILON);

                const user3Reward = directBonesReward(deposit3Block, withdrawal1Block).div(3)
                    .add(directBonesReward(withdrawal1Block, withdrawal2Block).div(2))
                    .add(directBonesReward(withdrawal2Block, withdrawal3Block).div(1));
                expect(await bonesBalance(context.user3)).to.be.closeTo(user3Reward, EPSILON);

                expect(await bonesBalance(context.wrappedSslp0)).to.be.closeTo(ether('0'), EPSILON);
            })

            it('bones distribution with non consecutive deposit and withdrawal with 3 users', async function () {
                const lockAmount = ether('0.4');
                const usdpAmount = ether('0.2');

                await prepareUserForJoin(context.user1, lockAmount);
                await prepareUserForJoin(context.user2, lockAmount);
                await prepareUserForJoin(context.user3, lockAmount);

                const {blockNumber: deposit1Block} = await wrapAndJoin(context.user1, lockAmount, usdpAmount);
                const {blockNumber: deposit2Block} = await wrapAndJoin(context.user2, lockAmount, usdpAmount);

                const {blockNumber: withdrawal1Block} = await unwrapAndExit(context.user1, lockAmount, usdpAmount);
                const {blockNumber: deposit3Block} = await wrapAndJoin(context.user3, lockAmount, usdpAmount);

                const {blockNumber: withdrawal2Block} = await unwrapAndExit(context.user2, lockAmount, usdpAmount);
                const {blockNumber: withdrawal3Block} = await unwrapAndExit(context.user3, lockAmount, usdpAmount);

                const user1Reward = directBonesReward(deposit1Block, deposit2Block)
                    .add(directBonesReward(deposit2Block, withdrawal1Block).div(2));
                expect(await bonesBalance(context.user1)).to.be.equal(user1Reward);

                const user2Reward = directBonesReward(deposit2Block, withdrawal1Block).div(2)
                    .add(directBonesReward(withdrawal1Block, deposit3Block))
                    .add(directBonesReward(deposit3Block, withdrawal2Block).div(2));
                expect(await bonesBalance(context.user2)).to.be.equal(user2Reward);

                const user3Reward = directBonesReward(deposit3Block, withdrawal2Block).div(2)
                    .add(directBonesReward(withdrawal2Block, withdrawal3Block));
                expect(await bonesBalance(context.user3)).to.be.equal(user3Reward);

                expect(await bonesBalance(context.wrappedSslp0)).to.be.equal(0);
            })

            it('deposited bones to wrapped lp before first lp deposit', async function () {
                const lockAmount = ether('0.4');
                const usdpAmount = ether('0.2');

                const depositedBones = ethers.BigNumber.from('1111111111111111111'); // 1.(1) ether
                context.boneToken.testMint(context.wrappedSslp0.address, depositedBones);

                await prepareUserForJoin(context.user1, lockAmount);
                await prepareUserForJoin(context.user2, lockAmount);
                await prepareUserForJoin(context.user3, lockAmount);

                const {blockNumber: deposit1Block} = await wrapAndJoin(context.user1, lockAmount, usdpAmount);
                const {blockNumber: deposit2Block} = await wrapAndJoin(context.user2, lockAmount, usdpAmount);
                const {blockNumber: withdrawal1Block} = await unwrapAndExit(context.user1, lockAmount, usdpAmount);
                const {blockNumber: deposit3Block} = await wrapAndJoin(context.user3, lockAmount, usdpAmount);
                const {blockNumber: withdrawal2Block} = await unwrapAndExit(context.user2, lockAmount, usdpAmount);
                const {blockNumber: withdrawal3Block} = await unwrapAndExit(context.user3, lockAmount, usdpAmount);

                // not all initial bones distributed bcs of imprecise distribution calculations
                const user1Reward = depositedBones
                    .add(directBonesReward(deposit1Block, deposit2Block))
                    .add(directBonesReward(deposit2Block, withdrawal1Block).div(2));
                expect(await bonesBalance(context.user1)).to.be.closeTo(user1Reward, EPSILON);

                const user2Reward = directBonesReward(deposit2Block, withdrawal1Block).div(2)
                    .add(directBonesReward(withdrawal1Block, deposit3Block))
                    .add(directBonesReward(deposit3Block, withdrawal2Block).div(2));
                expect(await bonesBalance(context.user2)).to.be.equal(user2Reward);

                const user3Reward = directBonesReward(deposit3Block, withdrawal2Block).div(2)
                    .add(directBonesReward(withdrawal2Block, withdrawal3Block));
                expect(await bonesBalance(context.user3)).to.be.equal(user3Reward);

                expect(await bonesBalance(context.wrappedSslp0)).to.be.closeTo(ether('0'), EPSILON);
            })

            it('withdraw all with remainder on wrapped lp and then deposit+withdraw', async function () {
                const lockAmount = ether('0.4');
                const usdpAmount = ether('0.2');

                await prepareUserForJoin(context.user1, lockAmount);
                await prepareUserForJoin(context.user2, lockAmount);
                await prepareUserForJoin(context.user3, lockAmount);

                await wrapAndJoin(context.user1, lockAmount, usdpAmount);
                await wrapAndJoin(context.user2, lockAmount, usdpAmount);
                await wrapAndJoin(context.user3, lockAmount, usdpAmount);

                await unwrapAndExit(context.user1, lockAmount, usdpAmount);
                await unwrapAndExit(context.user2, lockAmount, usdpAmount);
                await unwrapAndExit(context.user3, lockAmount, usdpAmount);

                const user1InitialReward = await bonesBalance(context.user1);
                const user2InitialReward = await bonesBalance(context.user2);
                const user3InitialReward = await bonesBalance(context.user3);
                const remainder = await bonesBalance(context.wrappedSslp0);
                expect(remainder).not.to.be.equal(0); // remainder

                await prepareUserForJoin(context.user1, lockAmount);
                await prepareUserForJoin(context.user2, lockAmount);
                await prepareUserForJoin(context.user3, lockAmount);

                const {blockNumber: deposit1Block} = await wrapAndJoin(context.user1, lockAmount, usdpAmount);
                const {blockNumber: deposit2Block} = await wrapAndJoin(context.user2, lockAmount, usdpAmount);
                const {blockNumber: withdrawal1Block} = await unwrapAndExit(context.user1, lockAmount, usdpAmount);
                const {blockNumber: deposit3Block} = await wrapAndJoin(context.user3, lockAmount, usdpAmount);
                const {blockNumber: withdrawal2Block} = await unwrapAndExit(context.user2, lockAmount, usdpAmount);
                const {blockNumber: withdrawal3Block} = await unwrapAndExit(context.user3, lockAmount, usdpAmount);

                const user1Reward = remainder
                    .add(user1InitialReward)
                    .add(directBonesReward(deposit1Block, deposit2Block))
                    .add(directBonesReward(deposit2Block, withdrawal1Block).div(2));
                expect(await bonesBalance(context.user1)).to.be.closeTo(user1Reward, EPSILON);

                const user2Reward = user2InitialReward
                    .add(directBonesReward(deposit2Block, withdrawal1Block).div(2))
                    .add(directBonesReward(withdrawal1Block, deposit3Block))
                    .add(directBonesReward(deposit3Block, withdrawal2Block).div(2));
                expect(await bonesBalance(context.user2)).to.be.equal(user2Reward);

                const user3Reward = user3InitialReward
                    .add(directBonesReward(deposit3Block, withdrawal2Block).div(2))
                    .add(directBonesReward(withdrawal2Block, withdrawal3Block));
                expect(await bonesBalance(context.user3)).to.be.equal(user3Reward);

                expect(await bonesBalance(context.wrappedSslp0)).to.be.closeTo(ether('0'), EPSILON);
            })

            it('simple case for pending reward', async function () {
                const lockAmount = ether('0.2');
                const usdpAmount = ether('0.1');

                await prepareUserForJoin(context.user1, lockAmount);

                expect(await pendingReward(context.user1)).to.be.equal(0);
                const {blockNumber: block1} = await wrapAndJoin(context.user1, lockAmount, usdpAmount);
                expect(await pendingReward(context.user1)).to.be.equal(0);

                await network.provider.send("evm_mine");
                const block2 = (await ethers.provider.getBlock("latest")).number
                expect(await pendingReward(context.user1)).to.be.equal(directBonesReward(block1, block2));

                await network.provider.send("evm_mine");
                const block3 = (await ethers.provider.getBlock("latest")).number
                expect(await pendingReward(context.user1)).to.be.equal(directBonesReward(block1, block3));

                const {blockNumber: block4} = await unwrapAndExit(context.user1, lockAmount, usdpAmount);
                expect(await pendingReward(context.user1)).to.be.equal(0);
            })

            it('complex case: bones distribution with non consecutive multiple deposit and withdrawal and reward claims with 3 users', async function () {
                const lockAmount = ether('0.5');
                const lockAmount2 = ether('1');
                const usdpAmount = ether('0.1');
                const usdpAmount2 = ether('0.2');

                await prepareUserForJoin(context.user1, ether('10'));
                await prepareUserForJoin(context.user2, ether('10'));
                await prepareUserForJoin(context.user3, ether('10'));

                let usersPendingReward = {
                    1: ether('0'),
                    2: ether('0'),
                    3: ether('0'),
                };
                let usersWithdrawnReward = {
                    1: ether('0'),
                    2: ether('0'),
                    3: ether('0'),
                };

                async function updateRewardsByPrevBlockAndCheck(block1, block2, actionUserNumber, user1Balance, user2Balance, user3Balance) {
                    const balances = {
                        1: ether(user1Balance),
                        2: ether(user2Balance),
                        3: ether(user3Balance),
                    }
                    const balancesSum = balances[1].add(balances[2]).add(balances[3])

                    usersPendingReward[1] = usersPendingReward[1].add(directBonesReward(block1, block2).mul(balances[1]).div(balancesSum));
                    usersPendingReward[2] = usersPendingReward[2].add(directBonesReward(block1, block2).mul(balances[2]).div(balancesSum));
                    usersPendingReward[3] = usersPendingReward[3].add(directBonesReward(block1, block2).mul(balances[3]).div(balancesSum));

                    if (actionUserNumber) {
                        // compare reward of user made action, since reward is sending on action
                        usersWithdrawnReward[actionUserNumber] = usersWithdrawnReward[actionUserNumber].add(usersPendingReward[actionUserNumber]);
                        usersPendingReward[actionUserNumber] = ether('0');
                    }

                    expect(await pendingReward(context.user1)).to.be.closeTo(usersPendingReward[1], EPSILON);
                    expect(await pendingReward(context.user2)).to.be.closeTo(usersPendingReward[2], EPSILON);
                    expect(await pendingReward(context.user3)).to.be.closeTo(usersPendingReward[3], EPSILON);
                    expect(await bonesBalance(context.user1)).to.be.closeTo(usersWithdrawnReward[1], EPSILON);
                    expect(await bonesBalance(context.user2)).to.be.closeTo(usersWithdrawnReward[2], EPSILON);
                    expect(await bonesBalance(context.user3)).to.be.closeTo(usersWithdrawnReward[3], EPSILON);
                }

                const {blockNumber: block1} = await wrapAndJoin(context.user1, lockAmount, usdpAmount); // 1-0.5, 2-0, 3-0
                const {blockNumber: block2} = await wrapAndJoin(context.user2, lockAmount2, usdpAmount2); // 1-0.5, 2-1, 3-0
                await updateRewardsByPrevBlockAndCheck(block1, block2, null, '0.5', '0', '0');

                const {blockNumber: block3} = await wrapAndJoin(context.user1, lockAmount, usdpAmount); // 1-1, 2-1, 3-0
                await updateRewardsByPrevBlockAndCheck(block2, block3, 1, '0.5', '1', '0');

                const {blockNumber: block4} = await unwrapAndExit(context.user2, lockAmount, usdpAmount); // 1-1, 2-0.5, 3-0
                await updateRewardsByPrevBlockAndCheck(block3, block4, 2, '1', '1', '0');

                const {blockNumber: block5} = await claimReward(context.user1); // 1-1, 2-0.5, 3-0
                await updateRewardsByPrevBlockAndCheck(block4, block5, 1, '1', '0.5', '0');

                const {blockNumber: block6} = await wrapAndJoin(context.user3, lockAmount2, usdpAmount2); // 1-1, 2-0.5, 3-1
                await updateRewardsByPrevBlockAndCheck(block5, block6, null, '1', '0.5', '0');

                await network.provider.send("evm_mine");
                await network.provider.send("evm_mine");
                await network.provider.send("evm_mine");

                const {blockNumber: block7} = await wrapAndJoin(context.user2, lockAmount, usdpAmount); // 1-1, 2-1, 3-1
                await updateRewardsByPrevBlockAndCheck(block6, block7, 2, '1', '0.5', '1');
                expect(block7 - block6).to.be.equal(4)

                const {blockNumber: block8} = await claimReward(context.user3); // 1-1, 2-1, 3-1
                await updateRewardsByPrevBlockAndCheck(block7, block8, 3, '1', '1', '1');

                const {blockNumber: block9} = await unwrapAndExit(context.user3, lockAmount, usdpAmount); // 1-1, 2-1, 3-0.5
                await updateRewardsByPrevBlockAndCheck(block8, block9, 3, '1', '1', '1');

                await network.provider.send("evm_mine");
                await network.provider.send("evm_mine");

                const {blockNumber: block10} = await claimReward(context.user3); // 1-1, 2-1, 3-0.5
                await updateRewardsByPrevBlockAndCheck(block9, block10, 3, '1', '1', '0.5');
                expect(block10 - block9).to.be.equal(3)

                const {blockNumber: block11} = await unwrapAndExit(context.user1, lockAmount, usdpAmount); // 1-0.5, 2-1, 3-0.5
                await updateRewardsByPrevBlockAndCheck(block10, block11, 1, '1', '1', '0.5');

                const {blockNumber: block12} = await claimReward(context.user1); // 1-0.5, 2-1, 3-0.5
                await updateRewardsByPrevBlockAndCheck(block11, block12, 1, '0.5', '1', '0.5');

                const {blockNumber: block13} = await unwrapAndExit(context.user1, lockAmount, usdpAmount); // 1-0, 2-1, 3-0.5
                await updateRewardsByPrevBlockAndCheck(block12, block13, 1, '0.5', '1', '0.5');

                const {blockNumber: block14} = await unwrapAndExit(context.user3, lockAmount, usdpAmount); // 1-0, 2-1, 3-0
                await updateRewardsByPrevBlockAndCheck(block13, block14, 3, '0', '1', '0.5');

                const {blockNumber: block15} = await unwrapAndExit(context.user2, lockAmount2, usdpAmount2); // 1-0, 2-0, 3-0
                await updateRewardsByPrevBlockAndCheck(block14, block15, 2, '0', '1', '0');

                expect(await bonesBalance(context.wrappedSslp0)).to.be.closeTo(ether('0'), EPSILON);
            })

            it('bones fee: 3 users + deposited bones to wrapped lp before first lp deposit + change receiver', async function () {
                await context.wrappedSslp0.setFee(10);
                const lockAmount = ether('0.4');
                const usdpAmount = ether('0.2');

                const depositedBones = ethers.BigNumber.from('1111111111111111111'); // 1.(1) ether
                context.boneToken.testMint(context.wrappedSslp0.address, depositedBones);

                await prepareUserForJoin(context.user1, lockAmount);
                await prepareUserForJoin(context.user2, lockAmount);
                await prepareUserForJoin(context.user3, lockAmount);

                const {blockNumber: deposit1Block} = await wrapAndJoin(context.user1, lockAmount, usdpAmount);
                const {blockNumber: deposit2Block} = await wrapAndJoin(context.user2, lockAmount, usdpAmount);
                const {blockNumber: withdrawal1Block} = await unwrapAndExit(context.user1, lockAmount, usdpAmount);
                const {blockNumber: deposit3Block} = await wrapAndJoin(context.user3, lockAmount, usdpAmount);
                const {blockNumber: withdrawal2Block} = await unwrapAndExit(context.user2, lockAmount, usdpAmount);
                await context.wrappedSslp0.setFeeReceiver(context.manager.address);
                await context.wrappedSslp0.setFee(20);
                const {blockNumber: withdrawal3Block} = await unwrapAndExit(context.user3, lockAmount, usdpAmount);

                // not all initial bones distributed bcs of imprecise distribution calculations
                const user1Reward = depositedBones
                    .add(directBonesReward(deposit1Block, deposit2Block))
                    .add(directBonesReward(deposit2Block, withdrawal1Block).div(2));
                const user1Fee = user1Reward.mul(10).div(100);
                expect(await bonesBalance(context.user1)).to.be.closeTo(user1Reward.sub(user1Fee), EPSILON);

                const user2Reward = directBonesReward(deposit2Block, withdrawal1Block).div(2)
                    .add(directBonesReward(withdrawal1Block, deposit3Block))
                    .add(directBonesReward(deposit3Block, withdrawal2Block).div(2));
                const user2Fee = user2Reward.mul(10).div(100);
                expect(await bonesBalance(context.user2)).to.be.equal(user2Reward.sub(user2Fee));

                const user3Reward = directBonesReward(deposit3Block, withdrawal2Block).div(2)
                    .add(directBonesReward(withdrawal2Block, withdrawal3Block));
                const user3FeePart1 = directBonesReward(deposit3Block, withdrawal2Block).div(2).mul(10).div(100);
                const user3FeePart2 = directBonesReward(withdrawal2Block, withdrawal3Block).mul(20).div(100);
                expect(await bonesBalance(context.user3)).to.be.equal(user3Reward.sub(user3FeePart1).sub(user3FeePart2));

                expect(await bonesBalance(context.bonesFeeReceiver)).to.be.closeTo(user1Fee.add(user2Fee).add(user3FeePart1), EPSILON);
                expect(await bonesBalance(context.manager)).to.be.closeTo(user3FeePart2, EPSILON);

                expect(await bonesBalance(context.wrappedSslp0)).to.be.closeTo(ether('0'), EPSILON);
            })

        });

        describe("bone lockers", function () {
            it('distribution bones from bone locker', async function () {
                const lockAmount = ether('0.8');
                const lockAmount2 = ether('0.4');
                const usdpAmount = ether('0.2');

                async function lockerClaimableReward(user) {
                    return await context.wrappedSslp0.connect(context.user3).getClaimableRewardAmountFromBoneLockers(user.address, [context.boneLocker1.address]); // everyone can view info
                }

                await context.topDog.setLockingPeriod(3600, 3600); // topdog calls bonelocker inside

                await prepareUserForJoin(context.user1, lockAmount);
                await prepareUserForJoin(context.user2, lockAmount);
                await prepareUserForJoin(context.user3, lockAmount);

                const {blockNumber: block1} = await wrapAndJoin(context.user1, lockAmount, usdpAmount);
                await mineBlocks(3)
                const {blockNumber: block2} = await wrapAndJoin(context.user2, lockAmount2, usdpAmount); // sent the first reward to pool + locked the first reward in locker
                expect(await lockerClaimableReward(context.user1)).to.be.equal(ether('0'));
                expect(await lockerClaimableReward(context.user2)).to.be.equal(ether('0'));

                await network.provider.send("evm_increaseTime", [3601]);
                await network.provider.send("evm_mine");
                expect(await lockerClaimableReward(context.user1)).to.be.equal(lockedBonesReward(block1, block2).mul(2).div(3));
                expect(await lockerClaimableReward(context.user2)).to.be.equal(lockedBonesReward(block1, block2).div(3));

                const block2_1 = (await ethers.provider.getBlock("latest")).number;
                let user1PendingReward = directBonesReward(block1, block2)
                    .add(directBonesReward(block2, block2_1).mul(2).div(3));
                let user2PendingReward = directBonesReward(block2, block2_1).div(3);
                expect(await pendingReward(context.user1)).to.be.closeTo(user1PendingReward, EPSILON);
                expect(await pendingReward(context.user2)).to.be.closeTo(user2PendingReward, EPSILON);

                expect(await bonesBalance(context.wrappedSslp0)).to.be.equal(directBonesReward(block1, block2)); // on pool only direct reward
                await lockerClaimReward()
                expect(await bonesBalance(context.wrappedSslp0)).to.be.equal(fullBonesReward(block1, block2)); // on pool all reward
                expect(await lockerClaimableReward(context.user1)).to.be.equal(ether('0')); // nothing to claim
                expect(await lockerClaimableReward(context.user2)).to.be.equal(ether('0')); // nothing to claim

                const block2_2 = (await ethers.provider.getBlock("latest")).number;
                user1PendingReward = user1PendingReward
                    .add(directBonesReward(block2_1, block2_2).mul(2).div(3))
                    .add(lockedBonesReward(block1, block2).mul(2).div(3)); // claimed reward reflects in pending reward
                user2PendingReward = user2PendingReward
                    .add(directBonesReward(block2_1, block2_2).div(3))
                    .add(lockedBonesReward(block1, block2).div(3)); // claimed reward reflects in pending reward

                expect(await pendingReward(context.user1)).to.be.closeTo(user1PendingReward, EPSILON);
                expect(await pendingReward(context.user2)).to.be.closeTo(user2PendingReward, EPSILON);

                ////////////////////////
                const {blockNumber: block3} = await unwrapAndExit(context.user1, lockAmount, usdpAmount); // sent the second reward to pool + locked the second reward in locker
                let reward = directBonesReward(block1, block2)
                    .add(directBonesReward(block2, block3).mul(2).div(3))
                    .add(lockedBonesReward(block1, block2).mul(2).div(3)) // locked reward distributed between 2 and 3, so divided between 2 users (in proportion of deposits)
                expect(await bonesBalance(context.user1)).to.be.closeTo(reward, EPSILON);
                expect(await lockerClaimableReward(context.user1)).to.be.equal(ether('0'));
                expect(await lockerClaimableReward(context.user2)).to.be.equal(ether('0'));

                await network.provider.send("evm_increaseTime", [3601]);
                await network.provider.send("evm_mine");
                expect(await lockerClaimableReward(context.user1)).to.be.equal(ether('0'));
                expect(await lockerClaimableReward(context.user2)).to.be.equal(lockedBonesReward(block2, block3));

                let currentPoolReward = await bonesBalance(context.wrappedSslp0);
                await lockerClaimReward()
                expect(await bonesBalance(context.wrappedSslp0)).to.be.equal(currentPoolReward.add(lockedBonesReward(block2, block3)));
                expect(await lockerClaimableReward(context.user1)).to.be.equal(ether('0'));
                expect(await lockerClaimableReward(context.user2)).to.be.equal(ether('0'));

                //////////////////////
                const {blockNumber: block4} = await unwrapAndExit(context.user2, lockAmount2, usdpAmount); // sent the 3rd reward to pool + locked the 3rd reward in locker
                reward = directBonesReward(block2, block3).div(3)
                    .add(lockedBonesReward(block1, block2).div(3)) // locked reward distributed between 2 and 3, so divided between 2 users (in proportion of deposits)
                    .add(directBonesReward(block3, block4))
                    .add(lockedBonesReward(block2, block3)) // locked reward distributed only to user 2 since it claimed after exit of the first user
                expect(await bonesBalance(context.user2)).to.be.closeTo(reward, EPSILON);
                expect(await lockerClaimableReward(context.user1)).to.be.equal(ether('0'));
                expect(await lockerClaimableReward(context.user2)).to.be.equal(ether('0'));

                await network.provider.send("evm_increaseTime", [3601]);
                await network.provider.send("evm_mine");
                expect(await lockerClaimableReward(context.user1)).to.be.equal(ether('0'));
                expect(await lockerClaimableReward(context.user2)).to.be.equal(ether('0'));

                expect(await bonesBalance(context.wrappedSslp0)).to.be.closeTo(ether('0'), EPSILON); // almost everything was withdrawn
                await lockerClaimReward()
                expect(await bonesBalance(context.wrappedSslp0)).to.be.closeTo(lockedBonesReward(block3, block4), EPSILON); // bones on pool, the first deposited user will get it
                expect(await lockerClaimableReward(context.user1)).to.be.equal(ether('0'));
                expect(await lockerClaimableReward(context.user2)).to.be.equal(ether('0'));

                ///////////////////
                let remainder = lockedBonesReward(block3, block4);
                const {blockNumber: block5} = await wrapAndJoin(context.user3, lockAmount, usdpAmount);
                const {blockNumber: block6} = await unwrapAndExit(context.user3, lockAmount, usdpAmount);
                expect(await bonesBalance(context.user3)).to.be.closeTo(remainder.add(directBonesReward(block5, block6)), EPSILON);
            })

            it('several bone lockers', async function () {
                const lockAmount = ether('0.02');
                const usdpAmount = ether('0.01');

                async function lockerClaimableReward(user, lockers) {
                    return await context.wrappedSslp0.connect(context.user3).getClaimableRewardAmountFromBoneLockers(user.address, lockers); // everyone can view info
                }

                async function getBoneLockerRewardsCount(lockers) {
                    return await context.wrappedSslp0.connect(context.user3).getBoneLockerRewardsCount(lockers); // everyone can view info
                }

                await context.topDog.setLockingPeriod(3600, 3600); // topdog calls bonelocker inside

                await prepareUserForJoin(context.user1, ether('1'));

                const boneLocker2 = await deployContract("BoneLocker_Mock", context.boneToken.address, "0x0000000000000000000000000000000000001234", 1, 3);
                await boneLocker2.transferOwnership(context.topDog.address);
                const boneLocker3 = await deployContract("BoneLocker_Mock", context.boneToken.address, "0x0000000000000000000000000000000000001234", 1, 3);
                await boneLocker3.transferOwnership(context.topDog.address);

                const boneLockers = [context.boneLocker1.address, boneLocker2.address, boneLocker3.address];

                const {blockNumber: block1} = await wrapAndJoin(context.user1, lockAmount, usdpAmount);
                await mineBlocks(2) // fot different bones reward
                const {blockNumber: block2} = await wrapAndJoin(context.user1, lockAmount, usdpAmount); // locked the first reward in locker1
                await mineBlocks(1)
                const {blockNumber: block3} = await wrapAndJoin(context.user1, lockAmount, usdpAmount); // locked the 2nd reward in locker1
                await mineBlocks(3)
                const {blockNumber: block4} = await wrapAndJoin(context.user1, lockAmount, usdpAmount); // locked the 3nd reward in locker1
                await mineBlocks(5)

                await context.topDog.boneLockerUpdate(boneLocker2.address);
                await context.topDog.setLockingPeriod(7200, 7200);

                const {blockNumber: block5} = await wrapAndJoin(context.user1, lockAmount, usdpAmount); // locked the first reward in locker2
                await mineBlocks(3)
                const {blockNumber: block6} = await wrapAndJoin(context.user1, lockAmount, usdpAmount); // locked the 2nd reward in locker2
                await mineBlocks(7)
                const {blockNumber: block7} = await wrapAndJoin(context.user1, lockAmount, usdpAmount); // locked the 3rd reward in locker2
                await mineBlocks(1)

                await context.topDog.boneLockerUpdate(boneLocker3.address);
                await context.topDog.setLockingPeriod(10000, 10000);

                const {blockNumber: block8} = await wrapAndJoin(context.user1, lockAmount, usdpAmount); // locked the first reward in locker3

                expect(await lockerClaimableReward(context.user1, boneLockers)).to.be.equal(ether('0'));

                const expectedLocker1Amount = lockedBonesReward(block1, block2)
                    .add(lockedBonesReward(block2, block3))
                    .add(lockedBonesReward(block3, block4));
                const expectedLocker2Amount = lockedBonesReward(block4, block5)
                    .add(lockedBonesReward(block5, block6))
                    .add(lockedBonesReward(block6, block7));
                const expectedLocker3Amount = lockedBonesReward(block7, block8);

                await network.provider.send("evm_increaseTime", [4000]);
                await network.provider.send("evm_mine");
                let claimableReward = await lockerClaimableReward(context.user1, boneLockers);
                expect(claimableReward).to.be.closeTo(expectedLocker1Amount, EPSILON);
                claimableReward = await lockerClaimableReward(context.user1, boneLockers.slice(0, 1));
                expect(claimableReward).to.be.closeTo(expectedLocker1Amount, EPSILON);
                claimableReward = await lockerClaimableReward(context.user1, boneLockers.slice(2, 3));
                expect(claimableReward).to.be.equal(ether('0'));
                let claimableRewardCounts = await getBoneLockerRewardsCount(boneLockers);
                expect(claimableRewardCounts[0]).to.be.equal(3);
                expect(claimableRewardCounts[1]).to.be.equal(0);
                expect(claimableRewardCounts[2]).to.be.equal(0);

                await network.provider.send("evm_increaseTime", [4000]);
                await network.provider.send("evm_mine");
                claimableReward = await lockerClaimableReward(context.user1, boneLockers);
                expect(claimableReward).to.be.closeTo(expectedLocker1Amount.add(expectedLocker2Amount), EPSILON);
                claimableReward = await lockerClaimableReward(context.user1, boneLockers.slice(1, 2));
                expect(claimableReward).to.be.closeTo(expectedLocker2Amount, EPSILON);
                claimableReward = await lockerClaimableReward(context.user1, boneLockers.slice(2, 3));
                expect(claimableReward).to.be.equal(ether('0'));
                claimableRewardCounts = await getBoneLockerRewardsCount(boneLockers);
                expect(claimableRewardCounts[0]).to.be.equal(3);
                expect(claimableRewardCounts[1]).to.be.equal(3);
                expect(claimableRewardCounts[2]).to.be.equal(0);

                await network.provider.send("evm_increaseTime", [4000]);
                await network.provider.send("evm_mine");
                claimableReward = await lockerClaimableReward(context.user1, boneLockers);
                expect(claimableReward).to.be.closeTo(expectedLocker1Amount.add(expectedLocker2Amount).add(expectedLocker3Amount), EPSILON);
                claimableReward = await lockerClaimableReward(context.user1, boneLockers.slice(1, 2));
                expect(claimableReward).to.be.closeTo(expectedLocker2Amount, EPSILON);
                claimableReward = await lockerClaimableReward(context.user1, boneLockers.slice(2, 3));
                expect(claimableReward).to.be.closeTo(expectedLocker3Amount, EPSILON);
                claimableRewardCounts = await getBoneLockerRewardsCount(boneLockers);
                expect(claimableRewardCounts[0]).to.be.equal(3);
                expect(claimableRewardCounts[1]).to.be.equal(3);
                expect(claimableRewardCounts[2]).to.be.equal(1);

                let currentBones = await bonesBalance(context.wrappedSslp0)
                await lockerClaimReward(boneLockers.slice(0, 1), 1);
                expect(await bonesBalance(context.wrappedSslp0)).to.be.equal(currentBones.add(lockedBonesReward(block1, block2)))
                claimableReward = await lockerClaimableReward(context.user1, boneLockers);
                expect(claimableReward).to.be.closeTo(expectedLocker1Amount.add(expectedLocker2Amount).add(expectedLocker3Amount).sub(lockedBonesReward(block1, block2)), EPSILON);
                claimableRewardCounts = await getBoneLockerRewardsCount(boneLockers);
                expect(claimableRewardCounts[0]).to.be.equal(2);
                expect(claimableRewardCounts[1]).to.be.equal(3);
                expect(claimableRewardCounts[2]).to.be.equal(1);

                currentBones = await bonesBalance(context.wrappedSslp0)
                await lockerClaimReward(boneLockers, 2);
                expect(await bonesBalance(context.wrappedSslp0)).to.be.closeTo(
                    currentBones
                        .add(lockedBonesReward(block2, block3))
                        .add(lockedBonesReward(block3, block4))
                        .add(lockedBonesReward(block4, block5))
                        .add(lockedBonesReward(block5, block6))
                        .add(lockedBonesReward(block7, block8)),
                    EPSILON
                )
                claimableReward = await lockerClaimableReward(context.user1, boneLockers);
                expect(claimableReward).to.be.closeTo(lockedBonesReward(block6, block7), EPSILON);
                claimableRewardCounts = await getBoneLockerRewardsCount(boneLockers);
                expect(claimableRewardCounts[0]).to.be.equal(0);
                expect(claimableRewardCounts[1]).to.be.equal(1);
                expect(claimableRewardCounts[2]).to.be.equal(0);

                currentBones = await bonesBalance(context.wrappedSslp0)
                await lockerClaimReward(boneLockers.slice(1, 3), 5);
                expect(await bonesBalance(context.wrappedSslp0)).to.be.closeTo(
                    currentBones
                        .add(lockedBonesReward(block6, block7)),
                    EPSILON
                )
                claimableReward = await lockerClaimableReward(context.user1, boneLockers);
                expect(claimableReward).to.be.equal(ether('0'));
                claimableRewardCounts = await getBoneLockerRewardsCount(boneLockers);
                expect(claimableRewardCounts[0]).to.be.equal(0);
                expect(claimableRewardCounts[1]).to.be.equal(0);
                expect(claimableRewardCounts[2]).to.be.equal(0);
            })

        });

        describe("topdog edge cases", function () {
            it('handle change of lptopken in topdog', async function () {
                const lockAmount = ether('0.4');
                const usdpAmount = ether('0.2');

                await prepareUserForJoin(context.user1, ether('1'));

                context.migratorShib = await deployContract("MigratorShib_Mock");
                await context.migratorShib.setNewToken(context.sslpToken1.address);
                await context.sslpToken1.transfer(context.migratorShib.address, ether('100'));
                await context.topDog.setMigrator(context.migratorShib.address);

                await wrapAndJoin(context.user1, lockAmount, usdpAmount);
                expect(await context.sslpToken0.balanceOf(context.user1.address)).to.be.equal(ether('0.6'), "rest of old lp tokens");
                expect(await context.sslpToken1.balanceOf(context.user1.address)).to.be.equal(ether('0'), "no user balance in new lp token");
                expect(await context.sslpToken0.balanceOf(context.topDog.address)).to.be.equal(lockAmount, "old lp tokens sent to topdog");
                expect(await context.sslpToken1.balanceOf(context.topDog.address)).to.be.equal(ether('0'), "no topdog balance in new lp token");

                expect(await context.wrappedSslp0.getUnderlyingToken()).to.be.equal(context.sslpToken0.address);
                await context.topDog.connect(context.user3).migrate(0); // anyone can migrate
                expect(await context.wrappedSslp0.getUnderlyingToken()).to.be.equal(context.sslpToken1.address);

                expect(await context.sslpToken0.balanceOf(context.user1.address)).to.be.equal(ether('0.6'), "rest of old lp tokens");
                expect(await context.sslpToken1.balanceOf(context.user1.address)).to.be.equal(ether('0'), "no user balance in new lp token");
                expect(await context.sslpToken0.balanceOf(context.topDog.address)).to.be.equal(lockAmount, "old lp tokens sent to topdog");
                expect(await context.sslpToken1.balanceOf(context.topDog.address)).to.be.equal(lockAmount, "topdog balance in new lp tokens");

                await unwrapAndExit(context.user1, lockAmount, usdpAmount);

                expect(await context.sslpToken0.balanceOf(context.user1.address)).to.be.equal(ether('0.6'), "nothing returned in old lp tokens");
                expect(await context.sslpToken1.balanceOf(context.user1.address)).to.be.equal(lockAmount, "but returned in new lp tokens");
                expect(await context.sslpToken0.balanceOf(context.topDog.address)).to.be.equal(lockAmount, "old lp tokens didn't use");
                expect(await context.sslpToken1.balanceOf(context.topDog.address)).to.be.equal(ether('0'), "no new lp tokens left in topdog");

            })
        });

        describe("liquidations related", function () {
            it('move position', async function () {
                const lockAmount = ether('0.4');
                const usdpAmount = ether('0.2');

                await prepareUserForJoin(context.user1, lockAmount);

                await context.vaultParameters.connect(context.deployer).setVaultAccess(context.deployer.address, true);

                const {blockNumber: block1} = await context.wrappedSslp0.connect(context.user1).deposit(context.user1.address, lockAmount);
                const {blockNumber: block2} = await context.wrappedSslp0.connect(context.deployer).movePosition(context.user1.address, context.user2.address, ether('0.1'));

                expect(await bonesBalance(context.user1)).to.be.equal(directBonesReward(block1, block2));
                expect(await context.sslpToken0.balanceOf(context.user1.address)).to.be.equal(ether('0.6'));
                expect(await context.wrappedSslp0.balanceOf(context.user1.address)).to.be.equal(ether('0.4'), 'no wrapped tokens transferred');
                expect(await context.wrappedSslp0.totalBalanceOf(context.user1.address)).to.be.equal(ether('0.4'), 'nothing changes in token balances');

                expect(await bonesBalance(context.user2)).to.be.equal(0);
                expect(await context.sslpToken0.balanceOf(context.user2.address)).to.be.equal(ether('1'));
                expect(await context.wrappedSslp0.balanceOf(context.user2.address)).to.be.equal(0, 'no wrapped tokens transferred');
                expect(await context.wrappedSslp0.totalBalanceOf(context.user2.address)).to.be.equal(0, 'nothing changes in token balances');

                // next movePosition us senselessly since contract is in inconsistent state
            })

            it('move position to the same user', async function () {
                const lockAmount = ether('0.4');
                const usdpAmount = ether('0.2');

                await prepareUserForJoin(context.user1, lockAmount);
                await prepareUserForJoin(context.user2, lockAmount);

                await context.vaultParameters.connect(context.deployer).setVaultAccess(context.deployer.address, true);

                const {blockNumber: block1} = await context.wrappedSslp0.connect(context.user1).deposit(context.user1.address, ether('0.1'));
                const {blockNumber: block2} = await context.wrappedSslp0.connect(context.user2).deposit(context.user2.address, lockAmount);
                const {blockNumber: block3} = await context.wrappedSslp0.connect(context.deployer).movePosition(context.user2.address, context.user2.address, ether('0.2'));

                expect(await bonesBalance(context.user1)).to.be.equal(0);

                let user2Bones = directBonesReward(block2, block3).mul(4).div(5)
                expect(await bonesBalance(context.user2)).to.be.equal(user2Bones);
                expect(await context.sslpToken0.balanceOf(context.user2.address)).to.be.equal(ether('0.6'));
                expect(await context.wrappedSslp0.balanceOf(context.user2.address)).to.be.equal(lockAmount, 'no wrapped tokens transferred');
                expect(await context.wrappedSslp0.totalBalanceOf(context.user2.address)).to.be.equal(lockAmount, 'position didnt change');

                let prevUser2Bones = await bonesBalance(context.user2);
                const {blockNumber: block4} = await context.wrappedSslp0.connect(context.deployer).movePosition(context.user2.address, context.user2.address, lockAmount);

                expect(await bonesBalance(context.user2)).to.be.equal(prevUser2Bones.add(directBonesReward(block3, block4).mul(4).div(5)))
                expect(await context.sslpToken0.balanceOf(context.user2.address)).to.be.equal(ether('0.6'));
                expect(await context.wrappedSslp0.balanceOf(context.user2.address)).to.be.equal(lockAmount, 'no wrapped tokens transferred');
                expect(await context.wrappedSslp0.totalBalanceOf(context.user2.address)).to.be.equal(lockAmount, 'position didnt change');

                prevUser2Bones = await bonesBalance(context.user2);
                const {blockNumber: block5} = await context.wrappedSslp0.connect(context.user2).withdraw(context.user2.address, lockAmount); // can withdraw

                expect(await bonesBalance(context.user2)).to.be.equal(prevUser2Bones.add(directBonesReward(block4, block5).mul(4).div(5)))
                expect(await context.sslpToken0.balanceOf(context.user2.address)).to.be.equal(ether('1'));
                expect(await context.wrappedSslp0.balanceOf(context.user2.address)).to.be.equal(0, 'wrapped tokens burned');
                expect(await context.wrappedSslp0.totalBalanceOf(context.user2.address)).to.be.equal(0, 'position closed');
            })

            it('liquidation (with moving position)', async function () {
                const lockAmount = ether('0.4');
                const usdpAmount = ether('0.2');

                await prepareUserForJoin(context.user1, lockAmount);
                await context.assetsBooleanParameters.set(context.wrappedSslp0.address, PARAM_FORCE_MOVE_WRAPPED_ASSET_POSITION_ON_LIQUIDATION, true);
                await context.usdp.mintForTests(context.user2.address, ether('1'));
                await context.usdp.connect(context.user2).approve(context.vault.address, ether('1'));

                await wrapAndJoin(context.user1, lockAmount, usdpAmount);

                await context.vaultManagerParameters.setInitialCollateralRatio(context.wrappedSslp0.address, ethers.BigNumber.from(9));
                await context.vaultManagerParameters.setLiquidationRatio(context.wrappedSslp0.address, ethers.BigNumber.from(10));


                await cdpManagerWrapper.triggerLiquidation(context, context.wrappedSslp0, context.user1);

                expect(await context.wrappedSslp0.balanceOf(context.vault.address)).to.be.equal(lockAmount, "wrapped tokens in vault");
                expect(await context.wrappedSslp0.totalBalanceOf(context.user1.address)).to.be.equal(lockAmount);
                expect(await context.wrappedSslp0.balanceOf(context.user1.address)).to.be.equal(0);
                expect(await context.wrappedSslp0.totalBalanceOf(context.user2.address)).to.be.equal(0);
                expect(await context.wrappedSslp0.balanceOf(context.user2.address)).to.be.equal(0);

                await mineBlocks(10)

                await context.liquidationAuction.connect(context.user2).buyout(context.wrappedSslp0.address, context.user1.address);

                expect(await context.wrappedSslp0.balanceOf(context.vault.address)).to.be.equal(0, "wrapped tokens not in vault");
                let ownerCollateralAmount = await context.wrappedSslp0.totalBalanceOf(context.user1.address);
                let liquidatorCollateralAmount = await context.wrappedSslp0.totalBalanceOf(context.user2.address);
                expect(lockAmount).to.be.equal(ownerCollateralAmount.add(liquidatorCollateralAmount))

                expect(await context.wrappedSslp0.balanceOf(context.user1.address)).to.be.equal(ownerCollateralAmount, 'tokens = position');
                expect(await context.wrappedSslp0.balanceOf(context.user2.address)).to.be.equal(liquidatorCollateralAmount, 'tokens = position');

                await context.wrappedSslp0.connect(context.user1).withdraw(context.user1.address, ownerCollateralAmount);
                await context.wrappedSslp0.connect(context.user2).withdraw(context.user2.address, liquidatorCollateralAmount);

                expect(await context.wrappedSslp0.totalSupply()).to.be.equal(0);
                expect(await context.sslpToken0.balanceOf(context.user1.address)).to.be.equal(ownerCollateralAmount.add(ether('0.6')), 'withdrawn all tokens');
                expect(await context.sslpToken0.balanceOf(context.user2.address)).to.be.equal(liquidatorCollateralAmount.add(ether('1')), 'withdrawn all tokens');
            })

            it('liquidation by owner (with moving position)', async function () {
                const lockAmount = ether('0.4');
                const usdpAmount = ether('0.2');

                await prepareUserForJoin(context.user1, lockAmount);
                await context.assetsBooleanParameters.set(context.wrappedSslp0.address, PARAM_FORCE_MOVE_WRAPPED_ASSET_POSITION_ON_LIQUIDATION, true);
                await context.usdp.connect(context.user1).approve(context.vault.address, ether('1'));

                await wrapAndJoin(context.user1, lockAmount, usdpAmount);

                await context.vaultManagerParameters.setInitialCollateralRatio(context.wrappedSslp0.address, ethers.BigNumber.from(9));
                await context.vaultManagerParameters.setLiquidationRatio(context.wrappedSslp0.address, ethers.BigNumber.from(10));

                await cdpManagerWrapper.triggerLiquidation(context, context.wrappedSslp0, context.user1);

                expect(await context.wrappedSslp0.balanceOf(context.vault.address)).to.be.equal(lockAmount, "wrapped tokens in vault");
                expect(await context.wrappedSslp0.totalBalanceOf(context.user1.address)).to.be.equal(lockAmount);
                expect(await context.wrappedSslp0.balanceOf(context.user1.address)).to.be.equal(0);

                await mineBlocks(52);

                await context.liquidationAuction.connect(context.user1).buyout(context.wrappedSslp0.address, context.user1.address);

                expect(await context.wrappedSslp0.balanceOf(context.vault.address)).to.be.equal(0, "wrapped tokens not in vault");
                expect(await context.wrappedSslp0.totalBalanceOf(context.user1.address)).to.be.equal(lockAmount);
                expect(await context.wrappedSslp0.balanceOf(context.user1.address)).to.be.equal(lockAmount);

                expect(await context.wrappedSslp0.balanceOf(context.user1.address)).to.be.equal(lockAmount, 'tokens = position');

                await context.wrappedSslp0.connect(context.user1).withdraw(context.user1.address, lockAmount);

                expect(await context.wrappedSslp0.totalSupply()).to.be.equal(0);
                expect(await context.sslpToken0.balanceOf(context.user1.address)).to.be.equal(ether('1'), 'withdrawn all tokens');

                expect(await context.usdp.balanceOf(context.user1.address)).to.be.not.equal(ether('0'), 'user1 with collateral and usdp :pokerface:');
            })
        });

        describe("parameters updates", function () {
            it('set fee receiver for manager only', async function () {
                await context.wrappedSslp0.setFeeReceiver('0x0000000000000000000000000000000000000005');

                await expect(
                  context.wrappedSslp0.connect(context.user3).setFeeReceiver('0x0000000000000000000000000000000000000006')
                ).to.be.revertedWith("AUTH_FAILED");

                expect(await context.wrappedSslp0.feeReceiver()).to.be.equal('0x0000000000000000000000000000000000000005');
            })

            it('set fee for manager only', async function () {
                await context.wrappedSslp0.setFee(3);

                await expect(
                  context.wrappedSslp0.connect(context.user3).setFee(7)
                ).to.be.revertedWith("AUTH_FAILED");

                expect(await context.wrappedSslp0.feePercent()).to.be.equal(3);
            })

            it('fee in range', async function () {
                await context.wrappedSslp0.setFee(50);
                await context.wrappedSslp0.setFee(0);

                await expect(
                  context.wrappedSslp0.setFee(51)
                ).to.be.revertedWith("INVALID_FEE");

                expect(await context.wrappedSslp0.feePercent()).to.be.equal(0);
            })
        });
    })

    oracleCases.forEach(params => {
        describe(`Oracles dependent tests with ${params[1]}`, function () {
            beforeEach(async function () {
                await prepareWrappedSSLP(context, params[0]);

                // initials distribution of lptokens to users
                await context.sslpToken0.transfer(context.user1.address, ether('1'));
                await context.sslpToken0.transfer(context.user2.address, ether('1'));
                await context.sslpToken0.transfer(context.user3.address, ether('1'));
            })

            describe("join/exit cases via cdp manager", function () {
                [1, 10].forEach(blockInterval =>
                    it(`simple deposit and withdrawal with interval ${blockInterval} blocks`, async function () {
                        const lockAmount = ether('0.4');
                        const usdpAmount = ether('0.2');

                        await prepareUserForJoin(context.user1, lockAmount);

                        const {blockNumber: depositBlock} = await wrapAndJoin(context.user1, lockAmount, usdpAmount);
                        expect(await context.sslpToken0.balanceOf(context.user1.address)).to.be.equal(ether('0.6'), "transferred from user");
                        expect(await context.usdp.balanceOf(context.user1.address)).to.be.equal(usdpAmount, "got usdp");
                        expect(await context.sslpToken0.balanceOf(context.topDog.address)).to.be.equal(lockAmount, "transferred to TopDog");
                        expect(await context.sslpToken0.balanceOf(context.wrappedSslp0.address)).to.be.equal(ether('0'), "transferred not to pool");
                        expect(await context.wrappedSslp0.balanceOf(context.vault.address)).to.be.equal(lockAmount, "wrapped token sent to vault");
                        expect(await context.wrappedSslp0.balanceOf(context.user1.address)).to.be.equal(0, "wrapped token sent not to user");
                        expect(await context.wrappedSslp0.totalBalanceOf(context.vault.address)).to.be.equal(0, "bault has not total balance");
                        expect(await context.wrappedSslp0.totalBalanceOf(context.user1.address)).to.be.equal(lockAmount, "wrapped token user total position");
                        expect(await context.wrappedSslp0.totalSupply()).to.be.equal(lockAmount, "minted only wrapped tokens for deposited amount");

                        for (let i = 0; i < blockInterval - 1; ++i) {
                            await network.provider.send("evm_mine");
                        }

                        const {blockNumber: withdrawalBlock} = await unwrapAndExit(context.user1, lockAmount, usdpAmount);
                        expect(await context.sslpToken0.balanceOf(context.user1.address)).to.be.equal(ether('1'), "returned all tokens to user");
                        expect(await context.usdp.balanceOf(context.user1.address)).to.be.equal(0, "returned usdp");
                        expect(await context.sslpToken0.balanceOf(context.topDog.address)).to.be.equal(0, "everything were withdrawn from TopDog");
                        expect(await context.sslpToken0.balanceOf(context.wrappedSslp0.address)).to.be.equal(ether('0'), "withdrawn not to pool");
                        expect(await context.wrappedSslp0.balanceOf(context.vault.address)).to.be.equal(0, "wrapped token withdrawn from vault");
                        expect(await context.wrappedSslp0.totalSupply()).to.be.equal(0, "everything were burned");

                        expect(await bonesBalance(context.user1)).to.be.equal(directBonesReward(depositBlock, withdrawalBlock), "bones reward got");
                    })
                );

                it(`simple deposit in one block`, async function () {
                    const lockAmount = ether('0.4');
                    const usdpAmount = ether('0.2');

                    await prepareUserForJoin(context.user1, lockAmount);

                    await network.provider.send("evm_setAutomine", [false]);
                    const joinTx = await wrapAndJoin(context.user1, lockAmount, usdpAmount);
                    const exitTx = await unwrapAndExit(context.user1, lockAmount, usdpAmount);
                    await network.provider.send("evm_mine");
                    await network.provider.send("evm_setAutomine", [true]);

                    const joinResult = await joinTx.wait();
                    const exitResult = await exitTx.wait();
                    expect(joinResult.blockNumber).to.be.equal(exitResult.blockNumber);
                    expect(joinResult.blockNumber).not.to.be.equal(null);

                    expect(joinTx).to.emit(cdpManagerWrapper.cdpManager(context), "Join").withArgs(context.wrappedSslp0.address, context.user1.address, lockAmount, usdpAmount);
                    expect(exitTx).to.emit(cdpManagerWrapper.cdpManager(context), "Exit").withArgs(context.wrappedSslp0.address, context.user1.address, lockAmount, usdpAmount);

                    expect(await context.sslpToken0.balanceOf(context.user1.address)).to.be.equal(ether('1'), "returned all tokens to user");
                    expect(await context.sslpToken0.balanceOf(context.topDog.address)).to.be.equal(0, "everything were withdrawn from TopDog");
                    expect(await context.wrappedSslp0.balanceOf(context.vault.address)).to.be.equal(0, "wrapped token withdrawn from vault");
                    expect(await context.wrappedSslp0.totalSupply()).to.be.equal(0, "everything were burned");

                    expect(await bonesBalance(context.user1)).to.be.equal(0, "bones reward got");
                });

                it(`simple case with several deposits`, async function () {
                    const lockAmount = ether('0.4');
                    const usdpAmount = ether('0.2');

                    await prepareUserForJoin(context.user1, lockAmount);

                    const {blockNumber: deposit1Block} = await wrapAndJoin(context.user1, lockAmount.div(2), usdpAmount.div(2));
                    const {blockNumber: deposit2Block} = await wrapAndJoin(context.user1, lockAmount.div(2), usdpAmount.div(2));
                    const reward = directBonesReward(deposit1Block, deposit2Block);
                    expect(await bonesBalance(context.user1)).to.be.equal(reward, "bones reward got");

                    const {blockNumber: withdrawalBlock} = await unwrapAndExit(context.user1, lockAmount, usdpAmount);
                    expect(await context.sslpToken0.balanceOf(context.user1.address)).to.be.equal(ether('1'), "returned all tokens to user");
                    expect(await context.sslpToken0.balanceOf(context.topDog.address)).to.be.equal(0, "everything were withdrawn from TopDog");
                    expect(await context.wrappedSslp0.balanceOf(context.vault.address)).to.be.equal(0, "wrapped token withdrawn from vault");
                    expect(await context.wrappedSslp0.totalSupply()).to.be.equal(0, "everything were burned");

                    expect(await bonesBalance(context.user1)).to.be.equal(directBonesReward(deposit2Block, withdrawalBlock).add(reward), "bones reward got");
                })

                it(`simple case with target repayment`, async function () {
                    const lockAmount = ether('0.4');
                    const usdpAmount = ether('0.2');

                    await prepareUserForJoin(context.user1, lockAmount);
                    await context.usdp.connect(context.user1).approve(context.vault.address, ether('1'));

                    await wrapAndJoin(context.user1, lockAmount, usdpAmount);
                    expect(await context.sslpToken0.balanceOf(context.user1.address)).to.be.equal(ether('0.6'), "sent tokens");
                    expect(await context.usdp.balanceOf(context.user1.address)).to.be.equal(usdpAmount, "got usdp");

                    await cdpManagerWrapper.unwrapAndExitTargetRepayment(context, context.user1, context.wrappedSslp0, ether('0.2'), ether('0.1'));
                    expect(await context.sslpToken0.balanceOf(context.user1.address)).to.be.equal(ether('0.8'), "returned tokens to user");
                    expect(await context.usdp.balanceOf(context.user1.address)).to.be.equal(ether('0.1'), "got usdp without fee");
                })

                it(`mint usdp only without adding collateral`, async function () {
                    const lockAmount = ether('0.4');
                    const usdpAmount = ether('0.1');

                    await prepareUserForJoin(context.user1, lockAmount);

                    await wrapAndJoin(context.user1, lockAmount, usdpAmount);
                    expect(await context.sslpToken0.balanceOf(context.user1.address)).to.be.equal(ether('0.6'), "sent tokens");
                    expect(await context.usdp.balanceOf(context.user1.address)).to.be.equal(usdpAmount, "got usdp");

                    await wrapAndJoin(context.user1, 0, usdpAmount);
                    expect(await context.usdp.balanceOf(context.user1.address)).to.be.equal(usdpAmount.mul(2), "got usdp");
                });

                it(`burn usdp without withdraw collateral`, async function () {
                    const lockAmount = ether('0.4');
                    const usdpAmount = ether('0.2');

                    await prepareUserForJoin(context.user1, lockAmount);

                    await wrapAndJoin(context.user1, lockAmount, usdpAmount);
                    expect(await context.sslpToken0.balanceOf(context.user1.address)).to.be.equal(ether('0.6'), "sent tokens");
                    expect(await context.usdp.balanceOf(context.user1.address)).to.be.equal(usdpAmount, "got usdp");

                    await unwrapAndExit(context.user1, 0, usdpAmount);
                    expect(await context.sslpToken0.balanceOf(context.user1.address)).to.be.equal(ether('0.6'), "tokens still locked");
                    expect(await context.usdp.balanceOf(context.user1.address)).to.be.equal(0, "no usdp");
                });
            });

            describe("cdp manager and direct wraps/unwraps", function () {
                it('exit without unwrap', async function () {
                    const lockAmount = ether('0.4');
                    const usdpAmount = ether('0.2');

                    await prepareUserForJoin(context.user1, ether('1'));

                    await wrapAndJoin(context.user1, lockAmount, usdpAmount);
                    await cdpManagerWrapper.exit(context, context.user1, context.wrappedSslp0, lockAmount, usdpAmount);
                    expect(await context.sslpToken0.balanceOf(context.user1.address)).to.be.equal(ether('0.6'), "nothing returned in lp tokens");
                    expect(await context.wrappedSslp0.balanceOf(context.user1.address)).to.be.equal(lockAmount, "but returned in new wrapped tokens");

                    // rescue of tokens - rejoin and unwrapAndExit
                    await cdpManagerWrapper.join(context, context.user1, context.wrappedSslp0, lockAmount, usdpAmount);
                    await unwrapAndExit(context.user1, lockAmount, usdpAmount);
                    expect(await context.sslpToken0.balanceOf(context.user1.address)).to.be.equal(ether('1'), "everything returned in lp tokens");
                    expect(await context.wrappedSslp0.balanceOf(context.user1.address)).to.be.equal(0, "zero wraped tokens");
                })

                it('exit without unwrap with direct unwrap', async function () {
                    const lockAmount = ether('0.4');
                    const usdpAmount = ether('0.2');

                    await prepareUserForJoin(context.user1, ether('1'));

                    await wrapAndJoin(context.user1, lockAmount, usdpAmount);
                    await cdpManagerWrapper.exit(context, context.user1, context.wrappedSslp0, lockAmount, usdpAmount);
                    expect(await context.sslpToken0.balanceOf(context.user1.address)).to.be.equal(ether('0.6'), "nothing returned in lp tokens");
                    expect(await context.wrappedSslp0.balanceOf(context.user1.address)).to.be.equal(lockAmount, "but returned in new wrapped tokens");

                    await context.wrappedSslp0.connect(context.user1).withdraw(context.user1.address, lockAmount);
                    expect(await context.sslpToken0.balanceOf(context.user1.address)).to.be.equal(ether('1'), "everything returned in lp tokens");
                    expect(await context.wrappedSslp0.balanceOf(context.user1.address)).to.be.equal(0, "zero wrapped tokens");
                })

                it('manual wrap and join and exit with cdp manager', async function () {
                    const lockAmount = ether('0.4');
                    const usdpAmount = ether('0.2');

                    await prepareUserForJoin(context.user1, ether('1'));

                    await context.wrappedSslp0.connect(context.user1).deposit(context.user1.address, lockAmount);
                    expect(await context.sslpToken0.balanceOf(context.user1.address)).to.be.equal(ether('0.6'), "send lp tokens");
                    expect(await context.sslpToken0.balanceOf(context.topDog.address)).to.be.equal(ether('0.4'), "top TopDog");
                    expect(await context.wrappedSslp0.balanceOf(context.user1.address)).to.be.equal(ether('0.4'), "got wrapped lp tokens");

                    await cdpManagerWrapper.join(context, context.user1, context.wrappedSslp0, lockAmount, usdpAmount);
                    expect(await context.wrappedSslp0.balanceOf(context.vault.address)).to.be.equal(ether('0.4'), "sent wrapped tokens to vault");

                    await unwrapAndExit(context.user1, lockAmount, usdpAmount);
                    expect(await context.sslpToken0.balanceOf(context.user1.address)).to.be.equal(ether('1'), "everything returned in lp tokens");
                    expect(await context.wrappedSslp0.balanceOf(context.user1.address)).to.be.equal(0, "zero wrapped tokens");
                    expect(await context.wrappedSslp0.balanceOf(context.vault.address)).to.be.equal(0, "zero wrapped tokens");
                })
            });
        })
    })
});

async function prepareUserForJoin(user, amount) {
    await context.sslpToken0.connect(user).approve(context.wrappedSslp0.address, amount);
    await context.wrappedSslp0.connect(user).approve(context.vault.address, amount);
}

async function pendingReward(user) {
    return await context.wrappedSslp0.pendingReward(user.address)
}

async function claimReward(user) {
    return await context.wrappedSslp0.connect(user).claimReward(user.address)
}

async function wrapAndJoin(user, assetAmount, usdpAmount) {
    return cdpManagerWrapper.wrapAndJoin(context, user, context.wrappedSslp0, assetAmount, usdpAmount);
}

async function unwrapAndExit(user, assetAmount, usdpAmount) {
    return cdpManagerWrapper.unwrapAndExit(context, user, context.wrappedSslp0, assetAmount, usdpAmount);
}

async function bonesBalance(user) {
    return await context.boneToken.balanceOf(user.address)
}

async function lockerClaimReward(lockers = [context.boneLocker1.address], maxRewardsAtOnce = 10) {
    await context.wrappedSslp0.connect(context.user3).claimRewardFromBoneLockers(lockers, maxRewardsAtOnce); // everyone can claim
}

async function mineBlocks(count) {
    for (let i = 0; i < count; ++i) {
        await network.provider.send("evm_mine");
    }
}