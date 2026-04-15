// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title OpsalisBilling
 * @notice Shared USDC payment router for Opsalis services (PingDog, ChainRPC,
 *         LoadTester, SwarmBrowser, L2aaS, ChainClone, Sertone).
 *         Each service registers a revenue wallet. Customers call pay(...) with
 *         a service+product id and a USDC amount that has been pre-approved to
 *         this contract. Funds are forwarded directly to the service wallet
 *         and a Paid event is emitted for off-chain indexers/backends.
 *
 *         Deployed on Demo L2 (chainId inferred from network). MockUSDC is
 *         the ERC-20 used for payments.
 */
interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

contract OpsalisBilling {
    address public immutable usdc;
    address public owner;

    // serviceId (keccak256("pingdog"), ...) => revenue wallet
    mapping(bytes32 => address) public serviceRevenueWallet;

    event Paid(
        bytes32 indexed serviceId,
        bytes32 indexed productId,
        address indexed customer,
        uint256 amount,
        uint256 timestamp
    );
    event ServiceWalletSet(bytes32 indexed serviceId, address wallet);
    event OwnerChanged(address indexed previousOwner, address indexed newOwner);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    constructor(address _usdc) {
        require(_usdc != address(0), "usdc=0");
        usdc = _usdc;
        owner = msg.sender;
        emit OwnerChanged(address(0), msg.sender);
    }

    function setServiceRevenueWallet(bytes32 serviceId, address wallet) external onlyOwner {
        require(wallet != address(0), "wallet=0");
        serviceRevenueWallet[serviceId] = wallet;
        emit ServiceWalletSet(serviceId, wallet);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "newOwner=0");
        emit OwnerChanged(owner, newOwner);
        owner = newOwner;
    }

    /**
     * @notice Pay `amount` of USDC from msg.sender to the service's revenue
     *         wallet. Caller must have approved at least `amount` to this
     *         contract beforehand.
     */
    function pay(bytes32 serviceId, bytes32 productId, uint256 amount) external {
        address wallet = serviceRevenueWallet[serviceId];
        require(wallet != address(0), "service not registered");
        require(amount > 0, "amount=0");
        bool ok = IERC20(usdc).transferFrom(msg.sender, wallet, amount);
        require(ok, "USDC transferFrom failed");
        emit Paid(serviceId, productId, msg.sender, amount, block.timestamp);
    }
}
