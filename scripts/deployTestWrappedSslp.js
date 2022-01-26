// temp script for testing wrapped sslp
//
// create key in alchemyapi.io
// run `npx hardhat node --fork https://eth-mainnet.alchemyapi.io/v2/<key>`
// run `npx hardhat --network localhost run scripts/deployTestWrappedSslp.js`
// connect with dapp

const {deployContract, attachContract} = require("../test/helpers/ethersUtils");
const {ORACLE_TYPE_UNISWAP_V2_KEYDONIX_WRAPPED_TO_UNDERLYING, ORACLE_TYPE_WRAPPED_TO_UNDERLYING,
    ORACLE_TYPE_UNISWAP_V2_POOL_TOKEN, ORACLE_TYPE_UNISWAP_V2_KEYDONIX_POOL_TOKEN,
    PARAM_FORCE_TRANSFER_ASSET_TO_OWNER_ON_LIQUIDATION, PARAM_FORCE_MOVE_WRAPPED_ASSET_POSITION_ON_LIQUIDATION
} = require("../lib/constants");

const MULTISIG_ADDR = '0xae37E8f9a3f960eE090706Fa4db41Ca2f2C56Cb8'
const VAULT = '0xb1cFF81b9305166ff1EFc49A129ad2AfCd7BCf19'
const USDP_ADDR = '0x1456688345527bE1f37E9e627DA0837D6f08C925'
const VAULT_PARAMETERS = '0xB46F8CF42e504Efe8BEf895f848741daA55e9f1D'
const CDP_VIEWER = '0x2cd49031ecb022cfA7c527Fd1AA5cE9FA187793D'
const VAULT_MANAGER_PARAMS = '0x203153522B9EAef4aE17c6e99851EE7b2F7D312E'
const VAULT_MANAGER_BORROW_FEE_PARAMS = "0xCbA7154bfBF898d9AB0cf0e259ABAB6CcbfB4894";
const ORACLE_REGISTRY = '0x75fBFe26B21fd3EA008af0C764949f8214150C8f'
const CDP_REGISTRY = '0x1a5Ff58BC3246Eb233fEA20D32b79B5F01eC650c'
const WRAPPED_ORACLE = '0x220Ea780a484c18fd0Ab252014c58299759a1Fbd'
const TOP_DOG = '0x94235659cf8b805b2c658f9ea2d6d6ddbb17c8d7'
const BONE_ADDR = '0x9813037ee2218799597d83d4a5b6f3b6778218d9'
const USDT_SSLP = '0x703b120F15Ab77B986a24c6f9262364d02f9432f'
const SHIB_SSLP = '0xCF6dAAB95c476106ECa715D48DE4b13287ffDEAa'
const TEST_WALLET = '0x8442e4fcbba519b4f4c1ea1fce57a5379c55906c'
const BONES_FEE = '0x0000000000000000000000000000000000000003'

async function deploy() {
    await ethers.provider.send("hardhat_impersonateAccount", [TEST_WALLET]);
    const testWallet = await ethers.getSigner(TEST_WALLET)

    await ethers.provider.send("hardhat_impersonateAccount", [MULTISIG_ADDR]);
    const multisig = await ethers.getSigner(MULTISIG_ADDR)
    await ethers.provider.send("hardhat_setBalance", [MULTISIG_ADDR, '0x3635c9adc5dea00000' /* 1000Ether */]);

    const vaultParameters = await attachContract('VaultParameters', VAULT_PARAMETERS);
    const cdpViewer = await deployContract('CDPViewer', VAULT_MANAGER_PARAMS, ORACLE_REGISTRY, VAULT_MANAGER_BORROW_FEE_PARAMS);
    console.log("cdpViewer: " + cdpViewer.address)

    //////// cdp manager ////////////////////////////////////////////
    const cdpManager = await deployContract("CDPManager01", VAULT_MANAGER_PARAMS, ORACLE_REGISTRY, CDP_REGISTRY, VAULT_MANAGER_BORROW_FEE_PARAMS);
    const cdpManagerKeydonix = await deployContract("CDPManager01_Fallback", VAULT_MANAGER_PARAMS, ORACLE_REGISTRY, CDP_REGISTRY, VAULT_MANAGER_BORROW_FEE_PARAMS);

    await vaultParameters.connect(multisig).setVaultAccess(cdpManager.address, true);
    await vaultParameters.connect(multisig).setVaultAccess(cdpManagerKeydonix.address, true);

    console.log("cdpManager: " + cdpManager.address)
    console.log("cdpManagerKeydonix: " + cdpManagerKeydonix.address)
    //////// end of cdp manager ////////////////////////////////////////////


    //////// wrapped assets ////////////////////////////////////////////
    const wrappedSslpUsdt = await deployContract('WrappedShibaSwapLp', VAULT_PARAMETERS, TOP_DOG, 17, BONES_FEE)
    const wrappedSslpShib = await deployContract('WrappedShibaSwapLp', VAULT_PARAMETERS, TOP_DOG, 0,  BONES_FEE)
    await wrappedSslpUsdt.connect(multisig).approveSslpToTopdog();
    await wrappedSslpShib.connect(multisig).approveSslpToTopdog();

    console.log("wrappedSslpUsdt: " + wrappedSslpUsdt.address)
    console.log("sslp usdt: " + USDT_SSLP)
    console.log("wrappedSslpShib (keydonix): " + wrappedSslpShib.address)
    console.log("sslp shib: " + SHIB_SSLP)
    //////// end of wrapped assets ////////////////////////////////////////////


    //////// oracles ////////////////////////////////////////////
    const oracleRegistry = await attachContract('OracleRegistry', ORACLE_REGISTRY);
    const wrappedKeydonixOracle = await deployContract('WrappedToUnderlyingOracleKeydonix', VAULT_PARAMETERS, ORACLE_REGISTRY);
    const wrappedOracle = await attachContract('WrappedToUnderlyingOracle', WRAPPED_ORACLE);

    await wrappedOracle.connect(multisig).setUnderlying(wrappedSslpUsdt.address, USDT_SSLP);
    await wrappedKeydonixOracle.connect(multisig).setUnderlying(wrappedSslpShib.address, SHIB_SSLP);

    await oracleRegistry.connect(multisig).setOracle(ORACLE_TYPE_UNISWAP_V2_KEYDONIX_WRAPPED_TO_UNDERLYING, wrappedKeydonixOracle.address);

    await oracleRegistry.connect(multisig).setOracleTypeForAsset(wrappedSslpUsdt.address, ORACLE_TYPE_WRAPPED_TO_UNDERLYING)
    await oracleRegistry.connect(multisig).setOracleTypeForAsset(wrappedSslpShib.address, ORACLE_TYPE_UNISWAP_V2_KEYDONIX_WRAPPED_TO_UNDERLYING)

    await oracleRegistry.connect(multisig).setOracleTypeForAsset(USDT_SSLP, ORACLE_TYPE_UNISWAP_V2_POOL_TOKEN)
    await oracleRegistry.connect(multisig).setOracleTypeForAsset(SHIB_SSLP, ORACLE_TYPE_UNISWAP_V2_KEYDONIX_POOL_TOKEN)

    // console.log('oracles check')
    // const price = BigInt((await wrappedOracle.assetToUsd(wrappedSslpUsdt.address, '1000000000000000000')).toString()) / (BigInt(2)**BigInt(112)) / (BigInt(10)**BigInt(18));
    // console.log('wrapped usdt lp price', price)
    // const poolOracle = await attachContract('OraclePoolToken', '0xd88e1F40b6CD9793aa10A6C3ceEA1d01C2a507f9')
    // const price2 = BigInt((await poolOracle.assetToUsd(USDT_SSLP, '1000000000000000000')).toString()) / (BigInt(2)**BigInt(112)) / (BigInt(10)**BigInt(18));
    // console.log('usdt lp price', price2)
    //////// end of oracles ////////////////////////////////////////////


    //////// collaterals ////////////////////////////////////////////
    const vaultManagerParameters = await attachContract('VaultManagerParameters', VAULT_MANAGER_PARAMS);

    await vaultManagerParameters.connect(multisig).setCollateral(
        wrappedSslpUsdt.address,
        '900', // stability fee
        '5', // liquidation fee
        '49', // initial collateralization
        '50', // liquidation ratio
        '0', // liquidation discount (3 decimals)
        '100', // devaluation period in blocks
        '1000000000000000000000', // debt limit
        [ORACLE_TYPE_WRAPPED_TO_UNDERLYING], // enabled oracles
        0,
        0,
    );
    await vaultManagerParameters.connect(multisig).setCollateral(
        wrappedSslpShib.address,
        '900', // stability fee
        '5', // liquidation fee
        '49', // initial collateralization
        '50', // liquidation ratio
        '0', // liquidation discount (3 decimals)
        '100', // devaluation period in blocks
        '1000000000000000000000', // debt limit
        [ORACLE_TYPE_WRAPPED_TO_UNDERLYING], // enabled oracles
        0,
        0,
    );

    // WARNING not for prod!! for testing of liquidations
    await vaultManagerParameters.connect(multisig).setInitialCollateralRatio(wrappedSslpUsdt.address, 100);
    await vaultManagerParameters.connect(multisig).setInitialCollateralRatio(wrappedSslpShib.address, 100);
    //////// end of collaterals ////////////////////////////////////////////


    //////// auction ////////////////////////////////////////////
    const parameters = await deployContract(
        'AssetsBooleanParameters',
        VAULT_PARAMETERS,
        ['0x4bfB2FA13097E5312B19585042FdbF3562dC8676', '0x988AAf8B36173Af7Ad3FEB36EfEc0988Fbd06d07'],
        [PARAM_FORCE_TRANSFER_ASSET_TO_OWNER_ON_LIQUIDATION, PARAM_FORCE_TRANSFER_ASSET_TO_OWNER_ON_LIQUIDATION]
    );

    await parameters.connect(multisig).set(wrappedSslpShib.address, PARAM_FORCE_MOVE_WRAPPED_ASSET_POSITION_ON_LIQUIDATION, true);
    await parameters.connect(multisig).set(wrappedSslpUsdt.address, PARAM_FORCE_MOVE_WRAPPED_ASSET_POSITION_ON_LIQUIDATION, true);

    const auction = await deployContract('LiquidationAuction02', VAULT_MANAGER_PARAMS, CDP_REGISTRY, parameters.address)
    console.log("liquidation auction: ", auction.address)
    //////// end of auction ////////////////////////////////////////////


    // simple case
    // const usdp = await attachContract('USDP', USDP_ADDR);
    // const bone = await attachContract('IERC20', BONE_ADDR)
    //
    // console.log('-- check')
    // const usdtSslp = await attachContract('IERC20', USDT_SSLP)
    // const balance = (await usdtSslp.balanceOf(TEST_WALLET)).toString();
    // console.log("balance of usdt sslp: ", balance)
    // console.log("balance of bone: ", (await bone.balanceOf(TEST_WALLET)).toString())
    //
    // await usdtSslp.connect(testWallet).approve(wrappedSslpUsdt.address, '1000000000000000000000');
    // await wrappedSslpUsdt.connect(testWallet).approve(VAULT, '1000000000000000000000');
    // await usdp.connect(testWallet).approve(cdpManager.address, '1000000000000000000000');
    //
    // await cdpManager.connect(testWallet).wrapAndJoin(wrappedSslpUsdt.address, balance, '50000000000000000000');
    //
    // console.log('claimable bones: ', (await wrappedSslpUsdt.pendingReward(testWallet.address)).toString())
    // await network.provider.send("evm_mine");
    // await network.provider.send("evm_mine");
    // console.log('claimable bones after 2 blocks: ', (await wrappedSslpUsdt.pendingReward(testWallet.address)).toString())
    // console.log('bones fees wallet balance before claim: ', (await bone.balanceOf(BONES_FEE)).toString())
    // await wrappedSslpUsdt.claimReward(testWallet.address)
    // console.log("balance of bone: ", (await bone.balanceOf(TEST_WALLET)).toString())
    // console.log('bones fees wallet balance after claim: ', (await bone.balanceOf(BONES_FEE)).toString())

    // console.log(await cdpViewer.getCollateralParameters(wrappedSslpUsdt.address, TEST_WALLET))
    // console.log(await cdpViewer.getTokenDetails(wrappedSslpUsdt.address, TEST_WALLET))
}


deploy()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

